import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory.");
await mkdir(output, { recursive: true });
const base = process.env.THREEJS_URL || "http://127.0.0.1:8876";
const health = await fetch(`${base}/api/health`).then(response => response.json());
assert.equal(health.externalSimulator, false);
const browser = await chromium.launch({ headless: true });
const report = { passed: false, mode: "live-headless-Chromium", renderDeviceScaleFactor: 0.75,
  base, screenshots: 0, images: [], errors: [], cameras: [], levels: [] };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.75 });
  page.setDefaultTimeout(90_000);
  page.on("pageerror", error => report.errors.push(error.stack || error.message));
  page.on("response", response => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico"))
      report.errors.push(`${response.status()} ${response.url()}`);
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  async function shot(name) {
    const sample = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const { world } = window.sim, p = world.player;
      resolve({ tick: world.tick, x: p.x, z: p.z, heading: p.heading, speed: p.speed,
        phase: world.pursuit?.phase, camera: window.sim.renderDiagnostics().cameraMode,
        style: window.sim.chaseCameraStyle, actors: world.actors.length });
    })));
    const bytes = await page.screenshot({ path: join(output, name), scale: "css" });
    report.images.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), ...sample });
    report.screenshots++;
    console.log(JSON.stringify({ screenshot: name, tick: sample.tick, speed: sample.speed }));
  }
  async function relativeCamera(offset) {
    await page.evaluate(([right, up, forward]) => {
      const { player: p } = window.sim.world, s = Math.sin(p.heading), c = Math.cos(p.heading);
      window.sim.setFreeCameraShot({
        pos: { x: p.x + c * right + s * forward, y: (p.y || 0) + up, z: p.z - s * right + c * forward },
        lookAt: { x: p.x, y: (p.y || 0) + 1, z: p.z },
      });
    }, offset);
  }
  async function advance(ticks) {
    await page.evaluate(ticks => {
      window.sim.pause(true);
      window.sim.step(ticks);
    }, ticks);
  }
  async function stopChase() {
    if (await page.locator("#stopChaseBtn").isVisible()) await page.locator("#stopChaseBtn").click();
    await page.evaluate(() => window.sim.pause(true));
  }
  async function startChase(level) {
    await page.evaluate(() => window.sim.setFreeCameraShot(null));
    if (!await page.locator("#pursuitRunBtn").isVisible()) await page.locator("#pakoBtn").click();
    await page.locator("#pursuitLevel").selectOption(String(level));
    await page.locator("#pursuitRunBtn").click();
    await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running");
    await page.evaluate(() => window.sim.pause(true));
    const state = await page.evaluate(() => {
      const { world } = window.sim;
      return { level: world.pursuit.level, baseSpeed: world.player.maxSpeed,
        config: world.pursuit.gta.config,
        patrols: [...world.pursuit.patrols].map(p => ({ id: p.id, maxSpeed: p.maxSpeed })),
        sameCity: world === window.__escapeOriginal.world,
        sameScene: window.sim.view.scene === window.__escapeOriginal.scene,
        originalsRetained: window.__escapeOriginal.actors.every(a => world.actors.includes(a)) };
    });
    assert.ok(state.sameCity && state.sameScene && state.originalsRetained, "Chase must retain the live City and population");
    assert.ok(state.patrols.length > 0);
    assert.ok(state.patrols.every(p => p.maxSpeed <= state.baseSpeed), JSON.stringify(state));
    report.levels.push(state);
  }
  await page.goto(base);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready && window.sim.defaultChaseReady, null, { timeout: 120_000 });
  await page.evaluate(() => {
    window.sim.pause(true);
    window.__escapeOriginal = { world: window.sim.world, scene: window.sim.view.scene, actors: [...window.sim.world.actors] };
  });
  report.ready = await page.evaluate(() => ({ environment: window.sim.world.environment,
    capacity: window.sim.world.capacity, renderer: window.sim.renderDiagnostics().renderer }));
  assert.equal(report.ready.environment, "metro");
  report.glazing = await page.evaluate(() => {
    const panes = [];
    window.sim.vehicleRig.root.traverse(object => {
      if (object.material?.name !== "SUV upright glazing") return;
      const { material } = object;
      panes.push({ name: object.name, color: material.color.toArray(),
        opacity: material.opacity, transparent: material.transparent, side: material.side });
    });
    return panes;
  });
  assert.ok(report.glazing.length >= 4);
  assert.ok(report.glazing.every(pane => pane.opacity === 1 && !pane.transparent &&
    pane.side === 0 && pane.color.every(channel => channel < 0.01)),
  "Exterior privacy panes must be opaque black and outward-facing");
  await shot("01-city-black-rear-glass.png");
  await relativeCamera([5, 2.8, 6]);
  await shot("02-black-windshield-front-quarter.png");
  await relativeCamera([-5, 2, 0]);
  await shot("03-black-left-side-glass.png");
  await relativeCamera([5, 2, 0]);
  await shot("04-black-right-side-glass.png");
  await page.evaluate(() => window.sim.setFreeCameraShot(null));
  for (const [name, mode, style] of [
    ["05-c-key-cockpit.png", "cockpit", "follow"],
    ["06-c-key-elevated-chasing.png", "chase", "chasing"],
    ["07-c-key-behind-car.png", "chase", "follow"],
  ]) {
    await page.keyboard.press("c");
    await settle();
    const camera = await page.evaluate(() => {
      const d = window.sim.renderDiagnostics();
      return { mode: d.cameraMode, style: d.chaseCameraStyle, position: d.cameraPosition };
    });
    assert.equal(camera.mode, mode);
    assert.equal(camera.style, style);
    report.cameras.push(camera);
    await shot(name);
  }
  assert.equal(new Set(report.cameras.map(c => JSON.stringify(c.position))).size, 3);
  await page.locator("#pakoBtn").click();
  await page.locator("#pakoDriverManual").click();
  await startChase(1);
  await page.evaluate(() => window.sim.pause(false));
  await page.keyboard.down("w");
  await page.keyboard.down("Shift");
  try {
    await page.waitForFunction(() => window.sim.world.player.nitroActive, null, { timeout: 30_000 });
    await page.evaluate(() => window.sim.pause(true));
    report.nitro = await page.evaluate(() => window.sim.nitroStatus());
    await shot("18-manual-nitro-advantage.png");
  } finally {
    await page.keyboard.up("Shift");
    await page.keyboard.up("w");
  }
  await stopChase();
  if (!await page.locator("#pakoDriverRl").isVisible()) await page.locator("#pakoBtn").click();
  await page.locator("#pakoDriverRl").click();
  await startChase(1);
  await shot("08-level-one-live-city-chase.png");
  const crowd = await page.evaluate(() => {
    const { world } = window.sim, before = world.actors.filter(a => a.type === "pedestrian").length;
    const outcome = window.sim.spawnCrowdAhead(20);
    return { outcome, before, after: world.actors.filter(a => a.type === "pedestrian").length, last: world.lastCrowdSpawn };
  });
  report.crowd = crowd;
  assert.equal(crowd.after - crowd.before, 20, JSON.stringify(crowd));
  await relativeCamera([0, 38, 18]);
  await shot("11-twenty-people-spread-overhead.png");
  await relativeCamera([-11, 6, 12]);
  await shot("12-crowd-traversable-gaps.png");
  await page.evaluate(() => window.sim.setFreeCameraShot(null));
  await advance(180);
  await shot("09-predictive-escape-progress.png");
  await advance(180);
  await shot("10-persistent-escape-route.png");
  report.chaseProgress = await page.evaluate(() => {
    const { world } = window.sim;
    return { tick: world.tick, metrics: world.pursuit.metrics, driver: {
      status: world.pursuit.frozenDriver?.status, decisions: world.pursuit.frozenDriver?.decisions,
      lastDecision: world.pursuit.frozenDriver?.lastDecision,
    } };
  });
  assert.ok(report.chaseProgress.driver.decisions > 0, "Actual loaded driver must make decisions");
  await advance(120);
  await shot("13-crowd-predictive-avoidance.png");
  for (const level of [2, 3, 4, 5]) {
    await stopChase();
    await startChase(level);
    await advance(30);
    await shot(`${String(12 + level).padStart(2, "0")}-level-${level}-speed-parity.png`);
  }
  await stopChase();
  report.props = [];
  for (const [id, label, index] of [["city-tree-4", "tree", 19], ["district-produce", "kiosk", 21]]) {
    const target = await page.evaluate(id => {
      const { world: w } = window.sim, p = w.player, t = w.statics.find(s => s.id === id);
      if (!t) throw new Error(`Missing physical City prop ${id}`);
      w.command({ type: "mode", mode: "manual" });
      Object.assign(p, { x: t.x, z: t.z - 6, heading: 0, speed: 0, steer: 0, path: [] });
      p.previous = { ...p.previous, x: p.x, z: p.z, heading: 0, speed: 0 };
      window.sim.view.sync(1);
      window.sim.setFreeCameraShot({
        pos: { x: t.x + 7, y: (p.y || 0) + 4.5, z: t.z - 10 },
        lookAt: { x: t.x, y: (p.y || 0) + 1.8, z: t.z },
      });
      return { id: t.id, x: t.x, z: t.z, width: t.width, length: t.length };
    }, id);
    await shot(`${index}-${label}-solid-before-impact.png`);
    const impact = await page.evaluate(async id => {
      const { world: w } = window.sim, p = w.player, t = w.statics.find(s => s.id === id);
      const { overlaps } = await import("/src/core/geometry.js");
      const { vehicleProbe } = await import("/src/core/vehicle.js");
      p.speed = 14;
      w.command({ type: "drive", targetSpeed: 14, steer: 0 });
      let penetrations = 0, contactTicks = 0;
      for (let i = 0; i < 60; i++) {
        w.step();
        penetrations += Number(overlaps(vehicleProbe(p), t));
        contactTicks += Number(p.vehicle.contact?.hitId === id);
      }
      window.sim.view.sync(1);
      return { id, penetrations, contactTicks, z: p.z, prop: t.propImpact,
        vehicleDamage: p.vehicle.damage.total, render: window.sim.view.cityProps.diagnostics() };
    }, id);
    assert.equal(impact.penetrations, 0, JSON.stringify(impact));
    assert.ok(impact.contactTicks > 0 && impact.prop.damage > 0 && impact.vehicleDamage > 0, JSON.stringify(impact));
    report.props.push({ target, impact });
    await shot(`${index + 1}-${label}-physical-impact-response.png`);
  }
  if (!await page.locator("#pako-training").isVisible()) await page.locator("#pakoBtn").click();
  await page.locator("#pako-training").click();
  await shot("23-training-scenarios.png");
  await page.locator("#closeSettings").click();
  await page.locator("#labBtn").click();
  await page.evaluate(() => window.sim.setFreeCameraShot(null));
  assert.equal(await page.evaluate(() => window.sim.world === window.__escapeOriginal.world &&
    window.__escapeOriginal.actors.every(a => window.sim.world.actors.includes(a))), true);
  await shot("24-original-city-retained.png");
  await page.setViewportSize({ width: 900, height: 650 });
  await shot("25-compact-city-camera.png");
  assert.equal(report.screenshots, 25);
  assert.equal(new Set(report.images.map(image => image.sha256)).size, 25, "All 25 frames must be distinct");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(join(output, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify({ passed: report.passed, screenshots: report.screenshots, cameras: report.cameras }));
