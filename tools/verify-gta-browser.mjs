import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url } = process.env;
assert.ok(output && url, "Run this check through scripts/verify_gta_browser.py");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(30_000);
const errors = [], report = {};
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
const shot = name => page.screenshot({ path: join(output, name) });

try {
  await page.goto(url);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
  await page.locator("#pauseBtn").click();
  assert.equal(await page.locator("#pauseBtn").textContent(), "Resume");
  await page.evaluate(() => {
    const { world, view } = window.sim;
    window.__gtaBrowser = { world, scene: view.scene, player: world.player,
      actors: world.actors.slice(), statics: world.statics, distanceM: world.player.distance };
  });
  await page.locator("#streetPursuitBtn").click();
  await page.locator("#pursuitStyle").selectOption("gta");
  await page.locator("#pursuitLevel").selectOption("5");
  assert.equal(await page.locator("#pursuitLevel").inputValue(), "5");
  await shot("gta-selector.png");
  await page.keyboard.down("w");
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => {
    const { world } = window.sim, run = world.pursuit;
    return run?.phase === "running" &&
      world.player.distance > window.__gtaBrowser.distanceM + 2 && run.manualAction?.throttle === 1 &&
      run.appliedCommand?.targetSpeed > 2;
  });
  await page.keyboard.up("w");
  report.live = await page.evaluate(() => {
    const { world, view } = window.sim, orig = window.__gtaBrowser;
    const run = world.pursuit, layer = view.scene.getObjectByName("pursuit-layer");
    return { variant: run.variant, phase: run.phase, mode: world.mode, openingStar: run.level, star: run.wantedLevel,
      distanceM: world.player.distance - orig.distanceM, health: world.player.health, tick: world.tick,
      sameCity: world === orig.world && view.scene === orig.scene && world.player === orig.player,
      originals: orig.actors.filter(actor => world.actors.includes(actor)).length,
      ordinaryCount: orig.actors.length, span: run.gta?.roadblock?.barrier.roadId,
      archetypes: [...new Set([...run.patrols].map(unit => unit.unitType))],
      barricadeRendered: layer.children.some(node => node.userData.gtaRoadblock),
      appearances: [...new Set(layer.children.map(node => node.userData.gtaAppearance).filter(Boolean))] };
  });
  assert.equal(report.live.variant, "gta");
  assert.equal(report.live.mode, "manual");
  assert.equal(report.live.openingStar, 5);
  assert.ok(report.live.star >= 1 && report.live.star <= 5, "running chase displays current wanted heat");
  assert.ok(report.live.sameCity && report.live.originals === report.live.ordinaryCount && report.live.distanceM > 2);
  assert.deepEqual(report.live.archetypes.sort(), ["interceptor", "patrol", "swat"]);
  assert.ok(report.live.span && report.live.barricadeRendered && report.live.appearances.includes("roadblock"));
  assert.ok(report.live.appearances.length >= 2, "resident pursuit vehicles have distinctive liveries");
  assert.ok(await page.locator("#pursuitHealth").isVisible());
  await shot("gta-live.png");

  await page.locator("#pursuitRestartBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "stopped" &&
    window.sim.view.scene.getObjectByName("pursuit-layer").children.every(node =>
      !node.userData.gtaAppearance && !node.userData.gtaRoadblock));
  report.cleanup = await page.evaluate(() => {
    const { world, view } = window.sim, orig = window.__gtaBrowser;
    return {
      sameCity: world === orig.world && world.player === orig.player && view.scene === orig.scene &&
        world.statics === orig.statics && world.actors.length === orig.actors.length &&
        world.actors.every((actor, i) => actor === orig.actors[i]),
      phase: world.pursuit.phase, police: world.pursuit.patrols.size, closures: world.pursuit.closures.size,
    };
  });
  assert.deepEqual(report.cleanup, { sameCity: true, phase: "stopped", police: 0, closures: 0 });
  await page.locator("#pursuitStyle").selectOption("hunt");
  assert.equal(await page.locator("#pursuitLevel").inputValue(), "4");
  assert.deepEqual(await page.locator("#pursuitLevel option[value='5']").evaluate(option =>
    [option.hidden, option.disabled]), [true, true]);
  await shot("gta-ended.png");
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = await page.evaluate(() => {
    const world = window.sim?.world, run = world?.pursuit;
    return { tick: world?.tick, phase: run?.phase, manual: run?.manualAction,
      speed: world?.player.speed, distance: world?.player.distance, guard: run?.metrics.guard,
      blocking: world?.player.blockedBy };
  });
  throw error;
} finally {
  report.errors = errors;
  await writeFile(join(output, "gta-browser.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
