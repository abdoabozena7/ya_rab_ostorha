import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url, METRO_IMPACT_BASELINE: baseline } = process.env;
const profile = baseline === "1" ? null : "accepted-contact-v1";
const seed = "city-route-dev-eval-00";
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const report = { engine: browser.version(), seed, errors: [] };
const snapshot = page => page.evaluate(() => window.sim.snapshot());

async function city() {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
  page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
  await page.locator("#pauseBtn").click();
  await page.waitForFunction(() => window.sim.paused);
  await clickCityTool(page, "settingsBtn");
  return page;
}

async function inspectCar(page) {
  if (!await page.locator("#carPanel").isVisible()) await clickCityTool(page, "carToggleBtn");
  await page.locator('[data-car-view="inspection"]').click();
  await page.locator("#carCloseBtn").click();
  // Inspect starts on the left. Orbit to the struck side using the regular canvas controls.
  await page.mouse.move(840, 520);
  await page.mouse.down();
  await page.mouse.move(658, 580, { steps: 8 });
  await page.mouse.up();
  const start = await page.evaluate(() => window.sim.renderDiagnostics().renderedFrames);
  await page.waitForFunction(start => window.sim.renderDiagnostics().renderedFrames >= start + 75, start);
}

const mesh = page => page.evaluate(() => {
  const rig = window.sim.vehicleRig;
  const positions = rig.root.getObjectByName("suv-right-doors").geometry.attributes.position.array;
  return { frame: window.sim.renderDiagnostics().renderedFrames, tick: window.sim.world.tick, panel: Array.from(positions),
    damage: rig.diagnostics.damage };
});

try {
  const page = await city(), form = page.locator("#settingsForm");
  await form.locator('[name="seed"]').fill(seed);
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(seed => window.sim.world.config.seed === seed && window.sim.world.tick === 0 &&
    window.sim.world.capacity.traffic === 36 && window.sim.world.capacity.pedestrians === 80, seed);
  if (await page.locator("#closeSettings").isVisible()) await page.locator("#closeSettings").click();
  await clickCityTool(page, "streetPursuitBtn");
  await page.locator("#pursuitStyle").selectOption("dispatch");
  await page.locator("#pursuitLevel").selectOption("5");
  await page.evaluate(() => {
    const { world } = window.sim, step = world.step;
    const ambient = world.actors.filter(actor => actor !== world.player);
    const sample = () => {
      const { speed, health, x, z, vehicle: { damage } } = world.player;
      return { speed, health, x, z, damage };
    };
    const trace = window.__metroImpact = { hits: [] };
    const pause = () => { if (!window.sim.paused) document.getElementById("pauseBtn").click(); };
    const key = (type, code) => document.body.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    world.step = function (...args) {
      const before = sample();
      const result = step.apply(this, args);
      const run = world.pursuit, { tick } = world;
      if (run?.phase !== "running") return result;
      if (tick === 476) {
        // Route the brake through the normal keyboard handler ahead of the next rendered frame.
        key("keyup", "KeyW");
        key("keydown", "Space");
      }
      if (tick === 660) {
        trace.before = before;
        pause();
      }
      const impact = run.metrics.impact;
      if (impact?.tick === tick) {
        const hit = { tick, before, after: sample(), impact,
          event: run.stepEvents.find(e => e.type === "patrol_collision" && e.fresh && e.actorId === impact.actorId) };
        trace.hits.push(hit);
        if (hit.event && before.speed === 0 && impact.side === "right" && impact.closingSpeedMps > 1) {
          trace.hit = hit;
          trace.population = { cars: ambient.filter(a => a.type === "vehicle").length,
            people: ambient.filter(a => a.type === "pedestrian").length,
            sameActors: ambient.every(a => world.actors.includes(a)) };
          delete world.step;
          pause();
        }
      }
      if (tick >= 840) pause();
      return result;
    };
  });
  await page.keyboard.down("w");
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.paused && window.__metroImpact.before);
  await inspectCar(page);
  const before = await mesh(page);
  await page.screenshot({ path: join(output, "impact-before.png") });
  await clickCityTool(page, "carToggleBtn");
  await page.locator('[data-car-view="chase"]').click();
  await page.locator("#carCloseBtn").click();
  await page.evaluate(() => {
    document.getElementById("pauseBtn").click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  });
  await page.waitForFunction(() => window.sim.paused && window.sim.world.tick >= 680);
  report.live = await page.evaluate(() => window.__metroImpact);
  assert.ok(report.live.hit, "ordinary manual input must lead to a real patrol hit on a held SUV");
  assert.ok(report.live.hit.after.health < report.live.hit.before.health);
  assert.deepEqual(report.live.population, { cars: 36, people: 80, sameActors: true });
  await inspectCar(page);
  const after = await mesh(page);
  await page.screenshot({ path: join(output, "impact-after.png") });
  const changedVertices = before.panel.filter((n, i) => i % 3 === 0 && n - after.panel[i] > .0001).length;
  report.renderedDamage = { ...after.damage, rightPanelChangedVertices: changedVertices,
    rightPanelMaxInwardM: Math.max(...before.panel.map((n, i) => i % 3 === 0 ? n - after.panel[i] : 0)),
    frames: [before.frame, after.frame], ticks: [before.tick, after.tick] };
  if (profile) {
    assert.ok(report.live.hit.after.damage.right > report.live.hit.before.damage.right);
    assert.equal(after.damage.lastImpact.tick, report.live.hit.tick);
    assert.ok(changedVertices > 3, "the right painted door must physically crease inward");
  } else {
    assert.deepEqual(report.live.hit.after.damage, report.live.hit.before.damage);
    assert.equal(changedVertices, 0);
  }

  const expected = await snapshot(page);
  await clickCityTool(page, "settingsBtn");
  const download = page.waitForEvent("download");
  await page.locator("#replayBtn").click();
  const recording = join(output, "impact-city-replay.json");
  await (await download).saveAs(recording);
  const replay = JSON.parse(await readFile(recording, "utf8"));
  const start = replay.events.find(e => e.command.type === "street-pursuit-start");
  report.recordedProfile = start.command.config.damageFeedback ?? null;
  report.manualTrace = replay.events.filter(e => e.command.type === "pursuit-drive");
  assert.equal(report.manualTrace[0].tick, start.tick);
  assert.equal(report.manualTrace[0].command.action.throttle, 1);
  assert.equal(report.manualTrace[1].command.action.brake, 1);
  assert.equal(report.recordedProfile, profile);
  await page.close();

  const restored = await city();
  await restored.locator("#replayFile").setInputFiles(recording);
  await restored.waitForFunction(() => document.getElementById("replayProgress").textContent ===
    "Replay restored from recorded commands.", null, { timeout: 25_000 });
  assert.deepEqual(await snapshot(restored), expected);
  report.sameSnapshot = true;
  await inspectCar(restored);
  const again = await mesh(restored);
  assert.deepEqual(again.panel, after.panel);
  assert.deepEqual(again.damage, after.damage);

  if (await restored.locator("#settingsPanel").isVisible()) await restored.locator("#closeSettings").click();
  if (!await restored.locator("#pursuitPanel").isVisible()) await clickCityTool(restored, "streetPursuitBtn");
  await restored.locator("#pursuitRestartBtn").click();
  for (const style of ["gta", "survival"]) {
    await restored.locator("#pursuitStyle").selectOption(style);
    await restored.locator("#pursuitRunBtn").click();
    const plain = await restored.evaluate(() =>
      window.sim.world.replay().events.findLast(e => e.command.type === "street-pursuit-start").command);
    assert.equal(plain.variant, style);
    assert.equal(plain.config?.damageFeedback, undefined);
    if (style === "survival") assert.equal(plain.config.giantPhysics, "scaled-v1");
    (report.legacyStarts ??= []).push(plain);
    await restored.locator("#pursuitRestartBtn").click();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(join(output, "metro-impact.json"), JSON.stringify(report, null, 2));
}
