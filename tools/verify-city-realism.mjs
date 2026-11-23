import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { clickCityTool } from "./city-tool-button.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use the runtime-proof collector to preserve fresh artifacts");
const base = process.env.THREEJS_URL || "http://127.0.0.1:8768/";
const negative = process.argv.includes("--negative-control");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(30000);
const report = { passed: false, errors: [], states: [] };
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", message => {
  if (message.type() === "error") report.errors.push(message.text());
});
page.on("response", response => {
  if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`);
});
const save = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2));
const state = () => page.evaluate(() => {
  const sim = window.sim, world = sim.world, rig = sim.vehicleRig;
  const wheel = rig.root.getObjectByName("wheel-front-left");
  return {
    tick: world.tick, environment: world.environment, paused: sim.paused,
    player: { x: world.player.x, z: world.player.z, speed: world.player.speed,
      steer: world.player.steer, heading: world.player.heading },
    wheelQuaternion: wheel.quaternion.toArray(),
    vehicle: structuredClone(world.player.vehicle),
    render: sim.renderDiagnostics(), assetFailures: [...sim.view.status.failed],
    sameWorld: window.__realismWorld === world,
    sameActors: window.__realismActors.every(actor => world.actors.includes(actor)),
    materials: sim.view.surfaces.road.map(mesh => ({
      normalMap: Boolean(mesh.material.normalMap),
      roughnessMap: Boolean(mesh.material.roughnessMap),
      normalScale: mesh.material.normalScale.toArray(),
      roughness: mesh.material.roughness,
      anisotropy: mesh.material.map?.anisotropy ?? 0,
    })),
    facadeRelief: Boolean(sim.view.facadeRelief),
    streetBudget: structuredClone(sim.view.egyptStreets.diagnostics.budget),
    lightingReady: Boolean(sim.view.scene.environment),
  };
});
const shot = name => page.screenshot({ path: join(output, name), timeout: 60000 });
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.sim?.vehicleRig &&
    window.sim.view.actorDiagnostics().ready &&
    window.sim.view.scene.environment &&
    window.sim.view.surfaces.road.some(mesh => mesh.material.normalMap));
  await page.evaluate(() => {
    window.sim.pause(true);
    window.__realismWorld = window.sim.world;
    window.__realismActors = [...window.sim.world.actors];
  });
  const before = await state();
  assert.equal(before.environment, "metro");
  assert.deepEqual(before.assetFailures, []);
  assert.ok(before.lightingReady && before.facadeRelief && before.streetBudget.withinBudget);
  assert.ok(before.materials.every(material => material.normalMap && material.roughnessMap),
    "Loaded City roads must have actual normal and roughness detail");
  report.states.push({ action: "default-city", ...before });
  if (negative) {
    await page.evaluate(() => {
      const rig = window.sim.vehicleRig;
      const wheel = rig.root.getObjectByName("wheel-front-left");
      const frozen = wheel.quaternion.clone(), update = rig.update.bind(rig);
      rig.update = (...args) => { update(...args); wheel.quaternion.copy(frozen); };
    });
  } else {
    await shot("city.png");
  }
  await clickCityTool(page, "carToggleBtn");
  await page.locator('[data-car-view="inspection"]').click();
  if (!negative) await shot("suv-detail.png");
  await page.locator("#carCutaway").check();
  await page.locator('[data-car-view="running-gear"]').click();
  if (!negative) await shot("running-gear.png");
  await page.locator('[data-car-view="cockpit"]').click();
  await page.evaluate(() => window.sim.pause(false));
  await page.keyboard.down("KeyD");
  await page.waitForFunction(() => Math.abs(window.sim.world.player.steer) > .12);
  await page.evaluate(() => window.sim.pause(true));
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(350);
  const steered = await state();
  const rackMoved = Math.abs(steered.player.steer - before.player.steer) > .1;
  const wheelMoved = Math.abs(steered.wheelQuaternion.reduce((sum, n, i) =>
    sum + n * before.wheelQuaternion[i], 0)) < .999;
  if (negative) {
    const detected = rackMoved && !wheelMoved;
    await save("negative.json", { detected, before, after: steered,
      fault: "Rendered front wheel frozen while real steering rack changes" });
    assert.ok(detected, "Motion oracle must catch disconnected rendered steering");
    process.exitCode = 3;
  } else {
    assert.ok(rackMoved && wheelMoved, "Rendered wheel must follow the actual rack");
    await shot("cockpit.png");
    await page.locator('[data-car-view="chase"]').click();
    await page.locator("#carCutaway").uncheck();
    await page.locator("#carCloseBtn").click();
    await page.evaluate(() => window.sim.pause(false));
    await page.keyboard.down("KeyW");
    await page.waitForFunction(start => Math.hypot(
      window.sim.world.player.x - start.x, window.sim.world.player.z - start.z) > .25, before.player);
    await page.evaluate(() => window.sim.pause(true));
    await page.keyboard.up("KeyW");
    await page.waitForTimeout(350);
    const driven = await state();
    assert.ok(Math.hypot(driven.player.x - before.player.x, driven.player.z - before.player.z) > .25,
      "Manual commands must move the actual City SUV");
    assert.ok(driven.sameWorld && driven.sameActors, "Inspection/driving must preserve the City");
    report.states.push({ action: "steered", ...steered }, { action: "driven", ...driven });
    await shot("city-driven.png");
    report.physics = await page.evaluate(async () => {
      const { integrateVehicle, vehicleVelocity, clearVehicleMotion } =
        await import("/src/core/vehicle.js");
      const { overlaps } = await import("/src/core/geometry.js");
      const sim = window.sim, world = sim.world, player = world.player;
      if (world.config.vehicleDynamics !== "city-realism-v1")
        throw new Error("Default City must actually opt in to the new dynamics");
      const dt = 1 / 60;
      const fast = { x: 0, z: 0, heading: 0, speed: 30, steer: .6,
        maxSpeed: 40, spec: player.spec };
      const turned = integrateVehicle(fast, { targetSpeed: 34, steer: .6 }, dt);
      const longitudinal = (turned.speed - fast.speed) / dt;
      const lateral = (turned.heading - fast.heading) / dt * (turned.speed + fast.speed) / 2;
      const legacySpec = { ...player.spec };
      delete legacySpec.tireGripMps2;
      const legacy = integrateVehicle({ ...fast, spec: legacySpec },
        { targetSpeed: 34, steer: .6 }, dt);
      const legacyLateral = legacy.heading / dt * (legacy.speed + fast.speed) / 2;
      const parked = world.statics.find(actor => actor.id === "grand-parked-tahrir-boulevard-0");
      if (!parked) throw new Error("Required real City parked vehicle is missing");
      const start = {
        x: parked.x,
        z: parked.z - parked.width / 2 -
          (Math.sin(.1) * player.length / 2 + Math.cos(.1) * player.width / 2) - .003,
        heading: Math.PI / 2 - .1, speed: 6, steer: 0, path: [],
      };
      Object.assign(player, start);
      clearVehicleMotion(player);
      sim.command({ type: "drive", targetSpeed: 6, steer: 0 });
      sim.step(1);
      const first = {
        speed: player.speed, velocity: vehicleVelocity(player),
        contact: structuredClone(player.vehicle.contact),
        damage: structuredClone(player.vehicle.damage),
        penetrating: overlaps(player, parked), audit: world.audit(),
      };
      sim.step(4);
      return {
        longitudinal, lateral, gripSquared: longitudinal ** 2 + lateral ** 2,
        legacyLateral,
        first,
        scraping: { impactCount: player.vehicle.damage.impactCount,
          penetrating: overlaps(player, parked), audit: world.audit() },
        sameWorld: world === window.__realismWorld,
        sameActors: window.__realismActors.every(actor => world.actors.includes(actor)),
      };
    });
    assert.ok(report.physics.gripSquared <= 64.000001 && Math.abs(report.physics.lateral) > 4,
      "High-speed turning and acceleration must share a finite tire-grip budget");
    assert.ok(Math.abs(report.physics.legacyLateral) > 8,
      "The same oracle must distinguish the previous unbounded high-speed response");
    assert.ok(report.physics.first.contact && report.physics.first.speed > 5 &&
      report.physics.first.speed <= 6 && !report.physics.first.penetrating,
    "A real City glancing impact must retain tangential motion without penetration");
    assert.ok(report.physics.first.damage.lastImpact.energyJ > 100 &&
      report.physics.first.damage.lastImpact.energyJ < 1000,
    "Damage must use actual low normal-closing energy, not all forward kinetic energy");
    assert.equal(report.physics.first.damage.impactCount, 1);
    assert.equal(report.physics.scraping.impactCount, 1, "Continuous scraping must not repeatedly dent");
    assert.equal(report.physics.scraping.penetrating, false);
    assert.deepEqual(report.physics.first.audit, []);
    assert.deepEqual(report.physics.scraping.audit, []);
    assert.ok(report.physics.sameWorld && report.physics.sameActors);
    await page.waitForTimeout(350);
    await shot("city-contact.png");
    assert.deepEqual(report.errors, []);
    report.passed = true;
    await save("result.json", report);
  }
} catch (error) {
  report.failure = error.stack;
  await save("result.json", report);
  throw error;
} finally {
  await browser.close();
}
