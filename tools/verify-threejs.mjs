import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const base = process.env.THREEJS_URL;
assert.ok(output && base, "Run through scripts/verify_threejs_recovery.py --browser");
await mkdir(output, { recursive: true });
const negative = process.argv.includes("--negative-control");
const report = { nativeRequests: [], unexpectedErrors: [], requests: [], states: [] };
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pendingAssets = new Set();
  page.on("pageerror", (error) => report.unexpectedErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !negative)
      report.unexpectedErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    report.requests.push(url);
    if (/^wss?:|\/api\/(?:simulation|gta|native)(?:\/|$)/.test(url))
      report.nativeRequests.push(url);
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin)
      report.unexpectedErrors.push(`External runtime request: ${url}`);
    if (url.startsWith(base + "assets/")) pendingAssets.add(request);
  });
  page.on("requestfinished", (request) => pendingAssets.delete(request));
  page.on("requestfailed", (request) => {
    pendingAssets.delete(request);
    if (!negative) report.unexpectedErrors.push(`Request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !negative)
      report.unexpectedErrors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  let blockedBundle = false;
  if (negative) {
    await page.route("**/public/threejs/game.bundle.js", (route) => {
      blockedBundle = true;
      return route.abort("failed");
    });
  }
  const response = await page.goto(base, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  await page.bringToFront();
  if (negative) {
    await page.waitForTimeout(1500);
    const liveGame = await page.evaluate(() => Boolean(window.sim));
    const shellVisible = await page.locator("#loadingStatus").isVisible();
    const result = { detected: blockedBundle && !liveGame && shellVisible, blockedBundle, liveGame, shellVisible };
    await writeFile(path.join(output, "negative.json"), JSON.stringify(result, null, 2));
    assert.ok(result.detected, "Missing bundle must be detected, not accepted as a running game");
    console.log("EXPECTED_GAME_BUNDLE_FAILURE_DETECTED");
    process.exitCode = 3;
  } else {
    await page.waitForFunction(() => Boolean(window.sim?.view?.status.loaded), undefined, { timeout: 60000 });
    const deadline = Date.now() + 45000;
    while (pendingAssets.size && Date.now() < deadline) await page.waitForTimeout(100);
    assert.equal(pendingAssets.size, 0, "All requested local assets must finish loading");
    await page.waitForTimeout(1000);
    const sample = () => page.evaluate(() => ({
      tick: window.sim.world.tick,
      environment: window.sim.world.environment,
      mode: window.sim.world.mode,
      position: { x: window.sim.world.player.x, z: window.sim.world.player.z },
      speed: window.sim.world.player.speed,
      destination: window.sim.world.destination?.id ?? null,
      seed: window.sim.world.config.seed,
      assetFailures: [...window.sim.view.status.failed],
      assetLoads: window.sim.view.status.loaded,
      audit: window.sim.audit(),
    }));
    const initial = await sample();
    report.states.push({ action: "loaded-city", ...initial });
    assert.equal(initial.environment, "metro");
    assert.deepEqual(initial.assetFailures, []);
    assert.deepEqual(initial.audit, []);
    await page.screenshot({ path: path.join(output, "start.png") });

    await page.keyboard.down("KeyW");
    await page.waitForTimeout(2200);
    await page.keyboard.up("KeyW");
    const manual = await sample();
    report.manualDistanceM = Math.hypot(
      manual.position.x - initial.position.x, manual.position.z - initial.position.z,
    );
    assert.ok(report.manualDistanceM > 0.1, "Keyboard throttle must move the actual player");
    report.states.push({ action: "manual-driving", ...manual });
    await page.screenshot({ path: path.join(output, "driving.png") });

    await page.locator("#pauseBtn").click();
    assert.equal(await page.evaluate(() => window.sim.paused), true);
    const pausedTick = await page.evaluate(() => window.sim.world.tick);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.sim.world.tick), pausedTick);
    await page.locator("#pauseBtn").click();

    await page.locator("#cameraBtn").click();
    assert.equal(await page.locator("#cameraLabel").isVisible(), false);
    await page.locator("#cameraBtn").click();
    assert.equal(await page.locator("#cameraLabel").isVisible(), true);
    await page.keyboard.press("KeyC");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, "driver-camera.png") });
    await page.keyboard.press("KeyC");

    await page.locator("#phoneToggleBtn").click();
    await page.locator("#phonePlaces").getByRole("button", { name: "السوق", exact: true }).click();
    await page.waitForFunction(() => window.sim.world.mode === "auto"
      && window.sim.world.destination?.id === "market");
    const autoStart = await sample();
    await page.waitForFunction(({ x, z }) => Math.hypot(
      window.sim.world.player.x - x, window.sim.world.player.z - z,
    ) > 0.2, autoStart.position, { timeout: 20000 });
    report.autoMoved = true;
    report.states.push({ action: "destination-autopilot", ...await sample() });
    await page.locator("#phoneToggleBtn").click();
    await clickCityTool(page, "inspectorBtn");
    assert.equal(await page.locator("#inspectorPanel").isVisible(), true);
    await page.screenshot({ path: path.join(output, "decision-lab.png") });
    await page.locator("#closeInspector").click();

    await page.evaluate(() => { window.__recoveryCity = window.sim.world; });
    await clickCityTool(page, "labBtn");
    report.labEnvironment = await page.evaluate(() => window.sim.world.environment);
    assert.equal(report.labEnvironment, "lab");
    const cityTick = await page.evaluate(() => window.__recoveryCity.tick);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__recoveryCity.tick), cityTick);
    await page.screenshot({ path: path.join(output, "test-lab.png") });
    report.states.push({ action: "independent-test-lab", ...await sample() });
    await clickCityTool(page, "labBtn");
    report.returnedCity = await page.evaluate(() =>
      window.sim.world === window.__recoveryCity && window.sim.world.environment === "metro");
    assert.ok(report.returnedCity, "Return must restore the existing city, not a new unrelated world");

    await clickCityTool(page, "settingsBtn");
    await page.locator('#settingsForm [name="seed"]').fill("threejs-recovery-ui");
    await page.locator('#settingsForm button[type="submit"]').click();
    await page.waitForFunction(() => window.sim.world.config.seed === "threejs-recovery-ui");
    report.resetRecovered = await page.evaluate(() =>
      window.sim.world !== window.__recoveryCity
      && window.sim.world.environment === "metro" && window.sim.audit().length === 0);
    assert.ok(report.resetRecovered, "Settings reset must create a usable clean city");
    await page.locator("#closeSettings").click();
    await page.waitForTimeout(700);
    report.states.push({ action: "reset-city", ...await sample() });
    await page.screenshot({ path: path.join(output, "recovered.png") });

    const health = await (await page.request.get(base + "api/health")).json();
    assert.equal(health.mode, "threejs");
    assert.equal(health.externalSimulator, false);
    const state = await (await page.request.get(base + "api/state")).json();
    assert.equal(state.connected, true);
    report.httpObservation = state;
    const frame = await page.request.get(base + "api/frame");
    assert.equal(frame.headers()["content-type"], "image/jpeg");
    assert.ok((await frame.body()).length > 1000, "Real rendered camera bytes must reach the observation API");
    report.cameraBytes = (await frame.body()).length;
    assert.deepEqual(report.nativeRequests, []);
    assert.deepEqual(report.unexpectedErrors, []);
    assert.ok(report.states.every((state) => state.assetFailures.length === 0));
    await writeFile(path.join(output, "journey.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      manualDistanceM: report.manualDistanceM, autoMoved: report.autoMoved,
      labEnvironment: report.labEnvironment, returnedCity: report.returnedCity,
      resetRecovered: report.resetRecovered, cameraBytes: report.cameraBytes,
      nativeRequests: report.nativeRequests, unexpectedErrors: report.unexpectedErrors,
    }));
  }
} catch (error) {
  report.failure = error.stack;
  await writeFile(path.join(output, "failure.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
