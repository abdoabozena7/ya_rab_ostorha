import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory.");
await mkdir(output, { recursive: true });
const base = process.env.THREEJS_URL || "http://127.0.0.1:8877";
const health = await fetch(`${base}/api/health`).then(response => response.json());
assert.equal(health.mode, "threejs");
assert.equal(health.externalSimulator, false);
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
const report = { passed: false, mode: "live standalone Chromium", shots: [], screenshots: 0, errors: [] };
const kingLong = "king-long-microbus", jetour = "jetour-t2";
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.75 });
  page.setDefaultTimeout(75_000);
  page.on("pageerror", error => report.errors.push(error.stack || error.message));
  page.on("response", response => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico"))
      report.errors.push(`${response.status()} ${response.url()}`);
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const select = page.locator("#playerVehicleSelect");
  const car = page.locator("#carPanel");
  const openCar = async () => {
    if (await car.isVisible()) return;
    if (!await page.locator("#carToggleBtn").isVisible()) await page.locator("#cityTools > summary").click();
    await page.locator("#carToggleBtn").click();
  };
  const closeCar = async () => {
    if (await car.isVisible()) await page.locator("#carCloseBtn").click();
    await blur();
  };
  const render = (afterFrame = false) => page.evaluate(async after => {
    if (after) await new Promise(resolve => requestAnimationFrame(resolve));
    const { world, view, vehicleRig } = window.sim, p = world.player;
    const camera = window.sim.renderDiagnostics();
    const sameCity = world === window.__kingLongBaseline.world && view === window.__kingLongBaseline.view;
    return {
      model: p.vehicleModel ?? "jetour-t2", asset: vehicleRig.diagnostics.asset,
      environment: world.environment, tick: world.tick, x: p.x, z: p.z, heading: p.heading,
      speed: p.speed, distance: p.distance, steer: p.steer, spin: p.vehicle.wheelSpinRad,
      wheel: vehicleRig.diagnostics.wheels.frontLeft, wheelAngle: p.vehicle.wheelAngles.frontLeft,
      roll: p.vehicle.suspension.rollRad, length: p.length, width: p.width, height: p.height,
      cameraMode: camera.cameraMode, cameraStyle: camera.chaseCameraStyle, camera: camera.cameraPosition,
      sameCity, sameScene: view.scene === window.__kingLongBaseline.scene,
      samePlayer: p === window.__kingLongBaseline.player,
      retained: window.__kingLongBaseline.people.every(actor => world.actors.includes(actor)),
      phase: world.pursuit?.phase, mode: world.mode, damage: p.vehicle.damage.total,
    };
  }, afterFrame);
  async function shot(name) {
    const state = await render(true);
    assert.ok(state.sameCity && state.sameScene && state.samePlayer && state.retained, "City continuity");
    const bytes = await page.screenshot({ path: join(output, name), scale: "css", timeout: 90_000 });
    report.shots.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), ...state });
    report.screenshots++;
    console.log(`${name} tick=${state.tick} speed=${state.speed.toFixed(2)}m/s`);
    return state;
  }
  const angle = (pos, at = [0, 1, 0]) => page.evaluate(({ pos, at }) => {
    const { world, view } = window.sim, p = world.player;
    const root = view.roots.get("player").root, s = Math.sin(p.heading), c = Math.cos(p.heading);
    const transform = ([x, y, z]) => ({
      x: root.position.x + c * x + s * z, y: root.position.y + y, z: root.position.z - s * x + c * z,
    });
    window.sim.setFreeCameraShot({ pos: transform(pos), lookAt: transform(at) });
  }, { pos, at });
  const clearAngle = () => page.evaluate(() => window.sim.setFreeCameraShot(null));
  const pick = model => select.selectOption(model);
  const advance = ticks => page.evaluate(ticks => window.sim.step(ticks), ticks);
  async function keys(keys, ticks) {
    await blur();
    for (const key of keys) await page.keyboard.down(key);
    try { await settle(); await advance(ticks); } finally {
      for (const key of keys) await page.keyboard.up(key);
    }
    return render();
  }
  const inView = mode => page.locator(`[data-car-view="${mode}"]`).click();

  await page.goto(base);
  await page.waitForFunction(() => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready, null, { timeout: 120_000 });
  await page.evaluate(() => {
    window.sim.pause(true);
    const { world, view } = window.sim;
    window.__kingLongBaseline = { world, view, scene: view.scene, player: world.player,
      people: [...world.actors], suv: window.sim.vehicleRig };
  });
  await page.locator("#cameraBtn").click();
  const original = await shot("01-original-jetour.png");
  assert.equal(original.environment, "metro");
  assert.equal(original.asset, "Original faceted SUV");
  assert.equal(original.model, jetour);
  assert.equal(original.wheel.radiusM, 0.35);

  await openCar();
  assert.deepEqual(await select.locator("option").evaluateAll(options => options.map(o => o.value)), [jetour, kingLong]);
  assert.equal(await select.inputValue(), jetour);
  await shot("02-player-vehicle-selector.png");
  await pick(kingLong);
  await angle([-4.8, 2.45, 5.7]);
  const bus = await shot("03-microbus-equipped.png");
  assert.match(bus.asset, /king long/i);
  assert.equal(bus.model, kingLong);
  assert.equal(bus.wheel.radiusM, 0.315);
  assert.deepEqual([bus.x, bus.z, bus.heading], [original.x, original.z, original.heading]);
  assert.ok(bus.length > original.length && bus.width < original.width && bus.height > original.height);
  assert.equal(await page.evaluate(() => window.__kingLongBaseline.suv.diagnostics.disposed), true);
  await closeCar();
  for (const [name, position, target] of [
    ["04-front-quarter.png", [-4.6, 2.6, 6.1]],
    ["05-driver-side.png", [-7.4, 2.15, 0.15]],
    ["06-sliding-door-side.png", [7.6, 2.1, 0.4]],
    ["07-short-nose-and-grille.png", [0.35, 1.77, 6.7], [0, 1.04, 1.6]],
    ["08-rear-quarter.png", [4.6, 2.8, -5.75], [0, 0.95, -0.75]],
    ["09-tailgate.png", [0.15, 2.1, -6.5], [0, 1.02, -1.6]],
  ]) {
    await angle(position, target);
    await shot(name);
  }
  await clearAngle();
  for (const [name, mode, style] of [
    ["10-c-key-cockpit.png", "cockpit", "follow"],
    ["11-c-key-elevated.png", "chase", "chasing"],
    ["12-c-key-behind.png", "chase", "follow"],
  ]) {
    await page.keyboard.press("c");
    const s = await shot(name);
    assert.equal(s.cameraMode, mode);
    assert.equal(s.cameraStyle, style);
  }
  await openCar();
  await inView("running-gear");
  await shot("13-running-gear.png");
  await inView("inspection");
  await shot("14-cutaway-passenger-cabin.png");
  await page.locator("#carCutaway").uncheck();
  await inView("chase");
  await closeCar();

  const straight = await keys(["w"], 155);
  assert.ok(straight.speed > 2.8 && straight.distance > 3 && Math.abs(straight.spin) > 0.15, JSON.stringify(straight));
  await angle([-4.2, 1.66, 4.5], [0, 0.9, 0]);
  await shot("15-w-accelerating-in-city.png");
  await openCar();
  await pick(jetour);
  assert.equal(await select.inputValue(), kingLong);
  assert.match(await page.locator("#carActionError").innerText(), /stop|moving/i);
  await shot("16-moving-switch-rejected.png");
  await closeCar();
  const turn = await keys(["w", "a"], 32);
  assert.ok(turn.heading > straight.heading + 0.04 && turn.wheelAngle > 0.05 && turn.roll > 0.01,
    JSON.stringify(turn));
  await angle([-4.6, 1.55, 5.9], [0, 0.77, 0.2]);
  await shot("17-steering-and-body-roll.png");
  const braking = await keys(["Space"], 16);
  assert.ok(braking.speed > 0 && braking.speed < turn.speed - 0.5);
  await angle([4.3, 1.5, -5.1]);
  await shot("18-space-braking.png");
  assert.equal((await keys(["Space"], 65)).speed, 0);
  const reverse = await keys(["s"], 80);
  assert.ok(reverse.speed < -0.4 && reverse.distance > braking.distance);
  await angle([5.4, 2.0, -5.4]);
  await shot("19-s-reversing.png");
  await keys(["Space"], 75);
  await clearAngle();
  await page.keyboard.press("c");
  const cockpit = await keys(["w"], 70);
  assert.ok(cockpit.speed > 0.5 && cockpit.cameraMode === "cockpit");
  await shot("20-driving-from-cockpit.png");
  await keys(["Space"], 70);
  await page.keyboard.press("c");
  await page.keyboard.press("c");

  await page.locator("#pakoBtn").click();
  assert.equal(await page.locator("#pakoDriverRl").isDisabled(), true);
  assert.equal(await page.locator("#pakoDriverManual").getAttribute("aria-pressed"), "true");
  await angle([-4.3, 3.1, 5.5]);
  await shot("21-manual-chase-ready.png");
  await clearAngle();
  await page.locator("#pursuitLevel").selectOption("1");
  await page.locator("#pursuitRunBtn").click();
  await blur();
  await page.keyboard.down("w");
  try {
    await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running" &&
      window.sim.world.pursuit.manualAction?.throttle === 1 && window.sim.world.player.speed > 1,
    null, { timeout: 90_000 });
    await page.evaluate(() => window.sim.pause(true));
  } finally { await page.keyboard.up("w"); }
  report.chase = await page.evaluate(() => {
    const w = window.sim.world;
    return { frozen: Boolean(w.pursuit.frozenDriver), playerCap: w.player.maxSpeed,
      patrolCaps: [...w.pursuit.patrols].map(p => p.maxSpeed), mass: w.player.spec.massKg };
  });
  assert.equal(report.chase.frozen, false);
  assert.ok(report.chase.playerCap < 32 && report.chase.patrolCaps.length > 0 &&
    report.chase.patrolCaps.every(cap => cap <= report.chase.playerCap));
  await shot("22-live-microbus-chase.png");
  await page.locator("#stopChaseBtn").click();
  if (await page.locator("#driveSenseClose").isVisible()) await page.locator("#driveSenseClose").click();
  if (await page.locator("#pursuitRunBtn").isVisible()) await page.locator("#pakoBtn").click();
  await keys(["Space"], 90);

  await page.setViewportSize({ width: 900, height: 650 });
  await openCar();
  assert.equal(await page.locator("#carActionError").isVisible(), false);
  const box = await select.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 900 && box.y + box.height <= 650,
    "The compact vehicle selector must stay inside the viewport");
  await angle([-4.7, 2.85, 6.3]);
  await shot("23-compact-vehicle-selector.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await closeCar();
  await angle([5.3, 3.15, 5.6]);
  const beforeRestoring = await shot("24-microbus-city-farewell.png");
  await openCar();
  await pick(jetour);
  await closeCar();
  await angle([-4.75, 2.7, 5.6]);
  const restored = await shot("25-jetour-restored-same-city.png");
  assert.equal(restored.model, jetour);
  assert.equal(restored.asset, original.asset);
  assert.deepEqual(restored.wheel.center, original.wheel.center);
  assert.deepEqual([restored.x, restored.z, restored.heading], [beforeRestoring.x, beforeRestoring.z, beforeRestoring.heading]);
  assert.deepEqual([restored.length, restored.width, restored.height], [original.length, original.width, original.height]);
  assert.equal(restored.wheel.radiusM, original.wheel.radiusM);
  assert.equal(report.screenshots, 25);
  assert.equal(new Set(report.shots.map(s => s.sha256)).size, 25);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  await writeFile(join(output, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
