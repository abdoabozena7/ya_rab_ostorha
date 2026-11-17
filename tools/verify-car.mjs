import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const base = process.env.THREEJS_URL;
assert.ok(output && base, "Run python scripts\\verify_car_quality.py --browser");
await mkdir(output, { recursive: true });
const negative = process.argv.includes("--negative-control");
const report = { unexpectedErrors: [], requests: [], states: [], details: [] };
const temporal = [];
const browser = await chromium.launch({
  headless: false,
  args: ["--force-device-scale-factor=1"],
});
let page;
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const quaternionAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, n, i) => sum + n * b[i], 0))));
const steeringChanged = (before, after) =>
  Math.abs(after.vehicle.wheelAngles.frontRight - before.vehicle.wheelAngles.frontRight) > 0.1
  && quaternionAngle(before.cockpitQuaternion, after.cockpitQuaternion) > 0.1;
try {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.unexpectedErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.unexpectedErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    report.requests.push(url);
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin)
      report.unexpectedErrors.push(`External runtime request: ${url}`);
    if (/^wss?:|\/api\/(?:simulation|gta|native)(?:\/|$)/.test(url))
      report.unexpectedErrors.push(`Unexpected native-simulator request: ${url}`);
  });
  page.on("requestfailed", (request) =>
    report.unexpectedErrors.push(`Request failed: ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400)
      report.unexpectedErrors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => window.sim?.vehicleRig
    && window.sim.world.player.vehicle && window.sim.view.status.failed.length === 0,
  undefined, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const state = () => page.evaluate(() => {
    const sim = window.sim, rig = sim.vehicleRig;
    rig.root.updateWorldMatrix(true, true);
    const steering = rig.root.getObjectByName("cockpit-steering");
    const wheelNames = ["front-left", "front-right", "rear-left", "rear-right"];
    const wheels = Object.fromEntries(wheelNames.map((name) => {
      const node = rig.root.getObjectByName("wheel-" + name);
      return [name, node ? {
        position: node.getWorldPosition(node.position.clone()).toArray(),
        quaternion: node.quaternion.toArray(),
      } : null];
    }));
    let paintChecksum = 0, paintVertices = 0;
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const materials = new Map();
    rig.root.traverse((node) => {
      if (!node.isMesh) return;
      for (let parent = node; parent; parent = parent.parent) {
        if (!parent.visible) return;
        if (parent === rig.root) break;
      }
      const surfaces = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of surfaces)
        if (material) materials.set(material.uuid, {
          name: material.name, flatShading: Boolean(material.flatShading),
          roughness: material.roughness, metalness: material.metalness,
        });
      const positions = node.geometry.getAttribute("position");
      const toVehicle = rig.root.matrixWorld.clone().invert().multiply(node.matrixWorld);
      const point = node.position.clone();
      for (let i = 0; i < positions.count; i++) {
        point.set(positions.getX(i), positions.getY(i), positions.getZ(i)).applyMatrix4(toVehicle);
        for (const [axis, value] of [point.x, point.y, point.z].entries()) {
          bounds.min[axis] = Math.min(bounds.min[axis], value);
          bounds.max[axis] = Math.max(bounds.max[axis], value);
        }
        if (surfaces.some((material) => /paint/i.test(material?.name ?? ""))) {
          paintChecksum += positions.getX(i) * 0.37 + positions.getY(i) * 0.71 + positions.getZ(i) * 1.13;
          paintVertices++;
        }
      }
    });
    const rays = sim.world.sensors.rays ?? [];
    const sensorMatrices = rays.map((ray) => {
      const node = rig.root.getObjectByName("sensor-range-" + ray.id);
      return { id: ray.id, origin: ray.origin,
        rendered: node?.getWorldPosition(node.position.clone()).toArray() ?? null };
    });
    return {
      wallMs: performance.now(), environment: sim.world.environment, tick: sim.world.tick,
      paused: sim.paused, mode: sim.world.mode,
      player: { x: sim.world.player.x, z: sim.world.player.z, speed: sim.world.player.speed,
        steer: sim.world.player.steer, heading: sim.world.player.heading },
      vehicle: structuredClone(sim.world.player.vehicle),
      testPhase: sim.world.vehicleTest?.phase ?? null,
      cockpitQuaternion: steering?.quaternion.toArray() ?? null,
      wheels, sensorMatrices, rawRanges: [...sim.world.sensors.rawM],
      auxiliary: structuredClone(sim.world.sensors.auxiliary ?? []),
      imu: structuredClone(sim.world.sensors.imu ?? null),
      modelBounds: bounds, materials: [...materials.values()],
      paintChecksum, paintVertices, audit: sim.audit(),
      assetFailures: [...sim.view.status.failed],
      render: sim.renderDiagnostics(),
    };
  });
  const capture = async (name, detail) => {
    await page.screenshot({ path: path.join(output, name + ".png") });
    if (detail) {
      await page.screenshot({ path: path.join(output, name + "-detail.png"), clip: detail });
      report.details.push({ frame: name + ".png", detail: name + "-detail.png", region: detail, scale: "native-resolution, no upscaling" });
    }
  };
  const initial = await state();
  assert.ok(initial.cockpitQuaternion, "The car needs an actual articulated cockpit steering node");
  assert.ok(Object.values(initial.wheels).every(Boolean), "All four actual rendered wheel nodes are required");
  assert.deepEqual(initial.assetFailures, []);
  const modelHeight = initial.modelBounds.max[1] - initial.modelBounds.min[1];
  const modelLength = initial.modelBounds.max[2] - initial.modelBounds.min[2];
  assert.ok(modelHeight / modelLength > 0.35,
    "The actual player's proportions must be a tall SUV, not the rejected low sports car");
  assert.ok(initial.materials.some((material) => material.roughness >= 0.6 && material.metalness <= 0.2),
    "The actual SUV needs restrained matte surfaces cohesive with existing traffic");
  assert.ok(report.requests.every((url) => !url.includes("player-concept.glb")),
    "The player must render its actual procedural SUV, not fetch the rejected sports model");
  report.suvStyleVerified = true;
  report.states.push({ action: "loaded-city", ...initial });

  if (negative) {
    await page.evaluate(() => {
      const rig = window.sim.vehicleRig;
      const steering = rig.root.getObjectByName("cockpit-steering");
      const frozen = steering.quaternion.clone();
      const update = rig.update.bind(rig);
      rig.update = (...args) => { update(...args); steering.quaternion.copy(frozen); };
    });
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(400);
    await page.keyboard.up("KeyD");
    const after = await state();
    const detected = !steeringChanged(initial, after)
      && Math.abs(after.vehicle.wheelAngles.frontRight) > 0.1;
    await save("negative.json", { detected, before: initial, after, fault: "isolated frozen rendered cockpit transform" });
    assert.ok(detected, "The real steering-coherence oracle must reject a disconnected cockpit");
    console.log("EXPECTED_STEERING_MISMATCH_DETECTED");
    process.exitCode = 3;
  } else {
    await capture("car-city");
    await page.locator("#carToggleBtn").click();
    await page.locator('[data-car-view="cockpit"]').click();
    await page.waitForTimeout(300);
    const latencyStart = Date.now();
    await page.keyboard.down("KeyD");
    await page.waitForFunction(() => window.sim.world.player.steer > 0.02);
    report.controlResponseMs = Date.now() - latencyStart;
    await page.waitForTimeout(320);
    const right = await state();
    await page.keyboard.up("KeyD");
    assert.ok(right.player.steer > 0, "D must turn right under the +Z-forward heading convention");
    assert.ok(steeringChanged(initial, right), "Cockpit steering must follow actual rack movement");
    assert.ok(Math.abs(right.vehicle.wheelAngles.frontRight) > Math.abs(right.vehicle.wheelAngles.frontLeft),
      "The inside right wheel must turn more than the outside wheel");
    await capture("cockpit-right", { x: 180, y: 330, width: 750, height: 500 });
    await page.keyboard.down("KeyA");
    await page.waitForTimeout(850);
    const left = await state();
    assert.ok(left.player.steer < 0, "A must turn left");
    assert.ok(Math.abs(left.vehicle.wheelAngles.frontLeft) > Math.abs(left.vehicle.wheelAngles.frontRight));
    await capture("cockpit-left");
    report.cockpitVerified = true;
    temporal.push({ action: "right-steering", ...right }, { action: "left-steering", ...left });
    await page.locator('[data-car-view="inspection"]').click();
    await page.keyboard.up("KeyA");
    await page.waitForTimeout(250);
    await capture("suv-body-inspection", { x: 230, y: 170, width: 740, height: 660 });
    await page.locator("#carCutaway").check();
    await page.locator("#carSensors").check();
    await page.waitForTimeout(300);
    assert.equal((await state()).paused, true, "Inspection must freeze the world rather than let the car drive away");
    await capture("cabin-cutaway", { x: 230, y: 170, width: 740, height: 660 });
    await page.locator('[data-car-view="running-gear"]').click();
    await page.waitForTimeout(250);
    await capture("running-gear", { x: 240, y: 230, width: 720, height: 600 });
    await page.locator('[data-car-view="chase"]').click();
    await page.locator("#carCutaway").uncheck();
    await page.locator("#carSensors").uncheck();
    await page.locator("#carCloseBtn").click();
    await page.waitForTimeout(850);
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(1600);
    await page.keyboard.up("KeyW");
    const driven = await state();
    assert.ok(Math.hypot(driven.player.x - initial.player.x, driven.player.z - initial.player.z) > 0.2);
    temporal.push({ action: "manual-driving", ...driven });
    await page.locator("#phoneToggleBtn").click();
    await page.locator("#phonePlaces").getByRole("button", { name: "السوق", exact: true }).click();
    await page.locator("#phoneToggleBtn").click();
    await page.waitForTimeout(500);
    report.responsiveness = await page.evaluate(async () => {
      const samples = [], start = performance.now(), first = window.sim.renderDiagnostics();
      const firstTick = window.sim.world.tick;
      let previousFrames = first.renderedFrames;
      while (performance.now() - start < 5000) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(), draw = window.sim.renderDiagnostics();
        if (draw.renderedFrames !== previousFrames) {
          samples.push({ wallMs: now, renderedFrames: draw.renderedFrames, tick: window.sim.world.tick,
            renderCalls: draw.renderCalls, triangles: draw.triangles,
            x: window.sim.world.player.x, z: window.sim.world.player.z });
          previousFrames = draw.renderedFrames;
        }
      }
      const elapsedSeconds = (performance.now() - start) / 1000;
      const last = window.sim.renderDiagnostics();
      const intervals = samples.slice(1).map((sample, i) => sample.wallMs - samples[i].wallMs).sort((a, b) => a - b);
      const usefulRenderedFps = (last.renderedFrames - first.renderedFrames) / elapsedSeconds;
      const ticksPerWallSecond = (window.sim.world.tick - firstTick) / elapsedSeconds;
      const p95FrameIntervalMs = intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))];
      return { usefulRenderedFps, ticksPerWallSecond, p95FrameIntervalMs, elapsedSeconds,
        samples, backing: { width: last.width, height: last.height, pixelRatio: last.pixelRatio },
        backend: last.backend, renderer: last.renderer,
        passed: usefulRenderedFps >= 25 && ticksPerWallSecond >= 45 && p95FrameIntervalMs <= 100
          && samples.every((sample) => sample.renderCalls > 0 && sample.triangles > 0) };
    });
    assert.equal(report.responsiveness.backing.width, 1365);
    assert.equal(report.responsiveness.backing.height, 900);
    assert.equal(report.responsiveness.backing.pixelRatio, 1);
    assert.ok(report.responsiveness.passed, JSON.stringify(report.responsiveness));
    assert.ok(report.controlResponseMs <= 300, `Control response was ${report.controlResponseMs} ms`);
    await capture("suv-in-traffic");
    await page.locator("#carToggleBtn").click();
    await page.evaluate(() => { window.__carAcceptanceCity = window.sim.world; });
    await page.locator("#carImpactBayBtn").click();
    await page.waitForFunction(() => window.sim.world.environment === "vehicle"
      && Boolean(window.sim.vehicleRig) && window.sim.world.vehicleTest?.phase === "ready");
    await page.waitForTimeout(700);
    const cityTick = await page.evaluate(() => window.__carAcceptanceCity.tick);
    const beforeImpact = await state();
    assert.equal(beforeImpact.vehicle.damage.total, 0);
    assert.ok(beforeImpact.paintVertices > 100, "The actual detailed painted model must be present");
    await page.locator("#carSensors").check();
    await page.waitForTimeout(300);
    const mounted = await state();
    assert.equal(mounted.sensorMatrices.length, 10);
    assert.equal(mounted.rawRanges.length, 5, "Existing front-range consumers keep their five values");
    assert.equal(mounted.auxiliary.length, 5);
    assert.equal(mounted.imu.source, "simulated-vehicle-state");
    for (const mount of mounted.sensorMatrices) {
      assert.ok(mount.rendered && mount.origin, `Missing actual rendered sensor lens ${mount.id}`);
      const origin = mount.origin;
      const error = Math.hypot(mount.rendered[0] - origin.x, mount.rendered[1] - origin.y, mount.rendered[2] - origin.z);
      assert.ok(error <= 0.02, `${mount.id}: lens/ray origins differ by ${error} m`);
    }
    report.sensorsVerified = true;
    await page.waitForTimeout(1200);
    const frontFrame = await page.request.get(base + "api/frame");
    assert.equal(frontFrame.headers()["content-type"], "image/jpeg");
    const frontImage = await frontFrame.body();
    const frontDirection = (await state()).render.sensorCameraDirection;
    await page.locator("#carSensorCamera").selectOption("rear");
    await page.waitForFunction(() => window.sim.renderDiagnostics().sensorCamera === "rear"
      && window.sim.renderDiagnostics().sensorCameraDirection[2] < -0.9);
    await page.waitForTimeout(1200);
    const rearFrame = await page.request.get(base + "api/frame");
    const rearImage = await rearFrame.body();
    const rearDirection = (await state()).render.sensorCameraDirection;
    assert.ok(frontDirection.reduce((sum, value, i) => sum + value * rearDirection[i], 0) < -0.99,
      "The selected installed rear camera must actually face opposite the front camera");
    assert.ok(!frontImage.equals(rearImage), "Rear selection must change the actual camera JPEG, not only a label");
    report.cameraFrames = {
      front: { bytes: frontImage.length, sha256: createHash("sha256").update(frontImage).digest("hex"), direction: frontDirection },
      rear: { bytes: rearImage.length, sha256: createHash("sha256").update(rearImage).digest("hex"), direction: rearDirection },
    };
    await capture("rear-camera");
    await page.locator("#carSensorCamera").selectOption("front");
    await page.waitForFunction(() => window.sim.renderDiagnostics().sensorCamera === "front"
      && window.sim.renderDiagnostics().sensorCameraDirection[2] > 0.9);
    report.cameraSwitchVerified = true;
    await page.locator("#carSensors").uncheck();
    await page.locator('[data-car-view="inspection"]').click();
    await page.waitForTimeout(250);
    await capture("pristine-front", { x: 240, y: 210, width: 740, height: 610 });
    await page.locator("#carSensors").check();
    await capture("sensor-mounts", { x: 250, y: 220, width: 720, height: 560 });
    await page.mouse.move(500, 350);
    await page.mouse.down();
    await page.mouse.move(900, 350, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await capture("suv-rear-inspection", { x: 230, y: 170, width: 740, height: 660 });
    await page.locator("#carImpactRunBtn").click();
    await page.waitForFunction(() => window.sim.world.vehicleTest.phase === "running");
    const impactSamples = await page.evaluate(async () => {
      const samples = [], deadline = performance.now() + 18000;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const world = window.sim.world;
        samples.push({ wallMs: performance.now(), tick: world.tick, x: world.player.x, z: world.player.z,
          speed: world.player.speed, phase: world.vehicleTest.phase,
          damage: structuredClone(world.player.vehicle.damage), rawRanges: [...world.sensors.rawM] });
        if (world.vehicleTest.phase === "contact") break;
      }
      return samples;
    });
    temporal.push(...impactSamples);
    const contact = await state();
    assert.equal(contact.testPhase, "contact", "The actual driven car must reach the fixture");
    assert.ok(contact.vehicle.damage.impactCount >= 1);
    assert.ok(contact.vehicle.damage.total > 0);
    assert.ok(contact.vehicle.damage.lastImpact.energyJ > 0);
    assert.ok(contact.vehicle.damage.lastImpact.closingSpeedMps > 0
      && contact.vehicle.damage.lastImpact.closingSpeedMps <= 6.001);
    assert.equal(contact.player.speed, 0);
    assert.deepEqual(contact.audit, [], "Contact must not leave the vehicle overlapping a barrier");
    assert.ok(Math.abs(contact.paintChecksum - beforeImpact.paintChecksum) > 0.001,
      "Contact must deform actual local painted-panel geometry, not only change a label");
    assert.ok(Math.min(...impactSamples.map((sample) => sample.rawRanges[2]))
      < beforeImpact.rawRanges[2] - 0.5, "Mounted range must change while approaching the fixture");
    await page.waitForTimeout(800);
    const restingContact = await state();
    assert.equal(restingContact.vehicle.damage.impactCount, contact.vehicle.damage.impactCount,
      "A stationary contact must not accumulate repeated impacts");
    assert.equal(await page.evaluate(() => window.__carAcceptanceCity.tick), cityTick,
      "The vehicle bay must not advance the paused city");
    report.realImpactVerified = true;
    await page.keyboard.down("KeyS");
    await page.waitForTimeout(1400);
    await page.keyboard.up("KeyS");
    await page.keyboard.down("Space");
    await page.waitForTimeout(650);
    await page.keyboard.up("Space");
    const backedOff = await state();
    assert.ok(backedOff.player.z < contact.player.z - 0.5,
      "Real reverse input must release the car from contact so the damaged front can be inspected");
    assert.ok(Math.abs(backedOff.player.speed) < 0.01);
    assert.equal(backedOff.vehicle.damage.impactCount, contact.vehicle.damage.impactCount);
    assert.equal(backedOff.vehicle.damage.total, contact.vehicle.damage.total);
    temporal.push({ action: "actual-reverse-contact-recovery", ...backedOff });
    await page.locator("#carSensors").uncheck();
    await page.locator('[data-car-view="inspection"]').click();
    await page.waitForTimeout(250);
    await capture("contact-damage", { x: 240, y: 210, width: 740, height: 610 });
    report.states.push({ action: "before-impact", ...beforeImpact }, { action: "mounted-sensors", ...mounted },
      { action: "actual-contact", ...contact });
    await page.locator("#carResetBtn").click();
    await page.waitForFunction(() => window.sim.world.vehicleTest?.phase === "ready"
      && window.sim.world.player.vehicle.damage.total === 0 && Boolean(window.sim.vehicleRig));
    await page.waitForTimeout(350);
    const repaired = await state();
    assert.equal(repaired.vehicle.damage.impactCount, 0);
    assert.ok(Math.abs(repaired.paintChecksum - beforeImpact.paintChecksum) < 0.001,
      "Reset must restore pristine cloned panel vertices");
    await capture("repaired-car");
    await page.locator('[data-car-view="inspection"]').click();
    await page.waitForTimeout(250);
    await capture("repaired-front", { x: 240, y: 210, width: 740, height: 610 });
    await page.locator('[data-car-view="chase"]').click();
    await page.setViewportSize({ width: 900, height: 650 });
    if (!await page.locator("#carPanel").isVisible())
      await page.locator("#carToggleBtn").click();
    await page.locator("#carPanel").evaluate((element) => { element.scrollTop = 0; });
    await capture("car-compact-panel-top");
    await page.locator("#carPanel").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await capture("car-compact-panel-bottom");
    await page.locator("#carPanel").evaluate((element) => { element.scrollTop = 0; });
    await page.locator('[data-car-view="cockpit"]').click();
    await page.waitForTimeout(250);
    await capture("car-compact-cockpit-panel");
    await page.locator('[data-car-view="chase"]').click();
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.locator("#labBtn").click();
    const returnedCity = await page.evaluate(() =>
      window.sim.world.environment === "city" && window.sim.world === window.__carAcceptanceCity);
    assert.ok(returnedCity);
    report.resetAndCityReturn = true;
    await page.setViewportSize({ width: 900, height: 650 });
    await page.waitForTimeout(350);
    const panelBounds = await page.locator("#carPanel").boundingBox();
    if (panelBounds) {
      assert.ok(panelBounds.x >= 0 && panelBounds.y >= 0);
      assert.ok(panelBounds.x + panelBounds.width <= 901);
      assert.ok(panelBounds.y + panelBounds.height <= 651);
    }
    await capture("car-compact-viewport");
    report.states.push({ action: "reset-car", ...repaired }, { action: "returned-city", ...await state() });
    assert.deepEqual(report.unexpectedErrors, []);
    assert.ok(report.states.every((sample) => sample.assetFailures.length === 0));
    await save("temporal.json", temporal);
    await save("car-journey.json", report);
    console.log(JSON.stringify({
      cockpitVerified: report.cockpitVerified, realImpactVerified: report.realImpactVerified,
      suvStyleVerified: report.suvStyleVerified, sensorsVerified: report.sensorsVerified,
      cameraSwitchVerified: report.cameraSwitchVerified, resetAndCityReturn: report.resetAndCityReturn,
      controlResponseMs: report.controlResponseMs,
      usefulRenderedFps: report.responsiveness.usefulRenderedFps,
      ticksPerWallSecond: report.responsiveness.ticksPerWallSecond,
      p95FrameIntervalMs: report.responsiveness.p95FrameIntervalMs,
      unexpectedErrors: report.unexpectedErrors,
    }));
  }
} catch (error) {
  report.failure = error.stack;
  await save("failure.json", report);
  await save("temporal.json", temporal);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failed.png") });
  throw error;
} finally {
  await browser.close();
}
