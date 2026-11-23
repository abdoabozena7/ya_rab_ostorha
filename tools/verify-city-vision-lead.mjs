import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const mode = process.env.CITY_VISION_CHECK;
assert.ok(output && base && ["density", "lead", "controls"].includes(mode));
const debug = process.env.CITY_VISION_DEVELOPMENT === "1";
assert.ok(!debug || !process.env.PROVE_IT_RUN_ID, "The sealed check cannot run in development mode");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
const report = { passed: false, mode, runs: [], errors: [] };
page.on("pageerror", error => report.errors.push(error.stack ?? error.message));
page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()}: ${response.url()}`); });
const wait = (fn, value, timeout = 20_000) => page.waitForFunction(fn, value, { timeout });
const shot = name => page.screenshot({ path: join(output, name) });
const ready = () => wait(() => window.sim?.view.actorDiagnostics().ready);
const modelReady = () => wait(() => window.sim.vision.status.result?.model?.id &&
  window.sim.vision.status.result.streamId === window.sim.vision.streamId, null, 30_000);

async function chooseDriver(value) {
  await clickCityTool(page, "settingsBtn");
  await page.locator("#cityDriver").selectOption(value);
  await page.locator("#closeSettings").click();
}

async function startDetector() {
  await clickCityTool(page, "cameraScreenToggleBtn");
  await page.locator("#cameraPerceptionStartBtn").click();
  await modelReady();
  await page.locator("#cameraScreenCloseBtn").click();
}

async function fixture(kind, side, driver, withhold = false) {
  await page.goto(base);
  await ready();
  await page.locator("#pauseBtn").click();
  await page.evaluate(({ kind, side }) => {
    const sim = window.sim;
    sim.reset({ seed: "metro-camera-causal-a", traffic: 0, pedestrians: 1,
      chaos: 0, speedLimit: 25, cityVersion: 4 });
    const world = sim.world, ego = world.player, person = world.actors.find(a => a.type === "pedestrian");
    const road = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
    const crossingX = ego.x + 23;
    const sideZ = ego.z + side * 3.9;
    const target = kind === "parallel" ? { x: crossingX + 9, z: sideZ } :
      kind === "stationary" ? { x: crossingX, z: sideZ } : { x: crossingX, z: ego.z - side * 3.65 };
    Object.assign(person, { kind: "man-polo", x: crossingX, z: sideZ, target, road,
      heading: kind === "parallel" || kind === "stationary" ? Math.PI / 2 : side > 0 ? Math.PI : 0,
      crossing: kind === "crossing", speed: 0, walkSpeed: 1.28, pause: .32, walkRoute: [target],
      walkGoal: `${target.x},${target.z}`, walkPlanTick: 0,
      motionMode: "stop",
      district: { ...person.district, caseId: "read-only-fixture", stage: "moving",
        routeConstrained: true, holdAtTarget: true, yieldAtCurb: false, origin: { x: crossingX, z: sideZ } } });
    person.previous = { ...person };
    world.updateSensors();
    window.__leadMeasure = { world, ego, person, road, crossingX, records: [], frames: new Map(), jpegs: new Map() };
  }, { kind, side });
  await page.locator("#pauseBtn").click();
  if (driver === "vision-first") await startDetector();
  else await chooseDriver("sensors-only");
  if (withhold) await page.route("**/api/vision/frame", route => route.abort("blockedbyclient"));
  await page.evaluate(({ driver, kind }) => {
    const { world, ego, person, road, crossingX, records, frames, jpegs } = window.__leadMeasure;
    Object.assign(ego, { speed: 6.2 });
    person.motionMode = kind === "stationary" ? "stop" : "ambient";
    person.pause = .32;
    const startTick = world.tick;
    const place = { x: crossingX + 24, z: ego.z, heading: ego.heading, roadId: road.id,
      id: "camera-witness", name: "Measured avenue" };
    world.command({ type: "visual-mode", mode: driver });
    if (!world.command({ type: "destination", place })) throw new Error("Fixture route is not usable");
    const step = world.step;
    world.step = function () {
      const speed = ego.speed;
      step.call(this);
      if (records.length > 720) return;
      const source = ego.districtSources;
      const visual = source?.visual;
      const age = visual?.ageMs;
      const actualMid = crossingX - ego.x - ego.length / 2 - person.radius;
      const gap = person.x - ego.x - ego.length / 2 - person.radius;
      const lat = person.z - ego.z;
      const hit = world.sensors.rays.some(ray => ray.hitId === person.id);
      const result = world.visualState;
      if (result?.available && !frames.has(result.frameId)) {
        const detection = window.sim.cameraResult(result.streamId, result.frameId);
        const frame = window.sim.cameraFrame(result.streamId, result.frameId);
        if (frame && result.frameId < 100) jpegs.set(result.frameId, frame.imageJpegBase64);
        frames.set(result.frameId, { streamId: result.streamId, frameId: result.frameId,
          timeS: detection?.simulationTimeS, provider: detection?.model?.provider,
          model: detection?.model?.id, ageMs: result.ageMs,
          samePixels: Boolean(frame && detection && frame.simulationTimeS === detection.simulationTimeS),
          people: detection?.detections.filter(item => item.label === "person") ?? [],
          forecasts: result.forecasts, tracks: result.tracks });
      }
      records.push({ tick: world.tick - startTick, sceneTick: world.tick, speed: ego.speed, decel: speed - ego.speed,
        gap, actualMid, lat, inside: Math.abs(lat) <= ego.width / 2 + person.radius,
        hit, blockedBy: ego.blockedBy, reason: ego.reason, applied: source?.appliedSource,
        visual: visual?.reason, age, available: visual?.available, cap: visual?.targetSpeedMps,
        final: source?.finalMps, evidenceId: visual?.evidenceTrackId, frameId: visual?.frameId,
        x: ego.x, z: ego.z, personX: person.x, personZ: person.z });
    };
  }, { driver, kind });
  await wait(() => window.__leadMeasure.records.length >= 420);
  await page.locator("#pauseBtn").click();
  const data = await page.evaluate(() => ({
    records: window.__leadMeasure.records, frames: [...window.__leadMeasure.frames.values()],
    audit: window.sim.world.audit(), target: window.__leadMeasure.person.id,
  }));
  const { records } = data;
  const qualified = (sample) => sample.available && sample.evidenceId &&
    (sample.applied === "camera-pixels" || sample.applied === "both") &&
    /^observed-(approach|person|motion)|^camera-evidence-hold|^visual-stop/.test(sample.visual ?? "");
  const onsetIndex = records.findIndex((sample, i) => qualified(sample) && sample.decel >= .025 &&
    records.slice(i, i + 6).filter(next => qualified(next) && next.decel > .02).length >= 5);
  const lead = onsetIndex < 0 ? null : records[onsetIndex];
  const sensor = records.find(sample => sample.hit) ?? null;
  const entry = records.find(sample => sample.inside) ?? null;
  const stop = lead && records.slice(onsetIndex + 1).find(sample => sample.speed <= .05 &&
    sample.actualMid >= 0 && sample.evidenceId === lead.evidenceId &&
    (sample.applied === "camera-pixels" || sample.applied === "both"));
  const evidence = lead && data.frames.find(frame => frame.frameId === lead.frameId);
  const result = { kind, side, driver, withhold, lead, sensor, entry, stop, evidence, ...data };
  report.runs.push(result);
  if (evidence) {
    const jpeg = await page.evaluate(id => window.__leadMeasure.jpegs.get(id), evidence.frameId);
    if (jpeg) {
      result.evidenceImage = `lead-${kind}-${side}.jpg`;
      await writeFile(join(output, result.evidenceImage), Buffer.from(jpeg, "base64"));
    }
  }
  if (withhold) await page.unroute("**/api/vision/frame");
  if (driver === "vision-first" && !withhold) {
    await clickCityTool(page, "cameraScreenToggleBtn");
    await shot(`lead-${kind}-${side}.png`);
    await page.locator("#cameraScreenCloseBtn").click();
  }
  return result;
}

async function denseCity() {
  await page.goto(base);
  await ready();
  assert.equal(await page.evaluate(() => window.sim.vision.status.result ?? null), null,
    "Loading City must not start local inference");
  await clickCityTool(page, "settingsBtn");
  await page.locator('[name="speedLimit"]').fill("50");
  await page.locator("#stressBtn").click();
  await page.locator("#closeSettings").click();
  await page.locator("#phoneToggleBtn").click();
  await page.locator("#phonePlaces").getByRole("button", { name: "الفرن البلدي", exact: true }).click();
  await modelReady();
  await wait(() => window.sim.world.mode === "auto" && window.sim.world.visualMode === "vision-first" &&
    window.sim.world.metrics.distance > 3, null, 45_000);
  report.timing = await page.evaluate(() => new Promise(resolve => {
    const { world } = window.sim, start = performance.now(), intervals = [];
    const first = { tick: world.tick, draws: window.sim.renderDiagnostics().renderedFrames, distance: world.metrics.distance };
    const times = new Map(), stream = window.sim.vision.streamId;
    let previous = start;
    function sample(now) {
      intervals.push(now - previous);
      previous = now;
      for (const timing of window.sim.vision.transport) {
        if (timing.streamId === stream && timing.observedAfterMs !== undefined) times.set(timing.frameId, { ...timing });
      }
      if (now - start < 6000) return requestAnimationFrame(sample);
      const draws = window.sim.renderDiagnostics(), duration = (now - start) / 1000;
      const collected = [...times.values()].slice(-Math.floor(duration * 10));
      const latencies = collected.map(item => item.observedAfterMs).sort((a, b) => a - b);
      const p95 = values => values[Math.max(0, Math.ceil(values.length * .95) - 1)];
      const windowResults = collected.filter(item => item.startedMs >= start - 500);
      resolve({ duration, fps: (draws.renderedFrames - first.draws) / duration,
        ticksPerSecond: (world.tick - first.tick) / duration, distanceM: world.metrics.distance - first.distance,
        renderP95Ms: p95(intervals.sort((a, b) => a - b)), latencyP95Ms: p95(latencies), frames: windowResults.length,
        provider: world.visualState?.model?.provider, renderer: draws.graphicsAdapter,
        view: [draws.width, draws.height, draws.pixelRatio], actors: {
          traffic: world.actors.filter(a => a.type === "vehicle" && a !== world.player).length,
          pedestrians: world.actors.filter(a => a.type === "pedestrian").length,
        }, audit: world.audit(), sampleCount: intervals.length });
    }
    requestAnimationFrame(sample);
  }));
  await clickCityTool(page, "cameraScreenToggleBtn");
  await wait(() => {
    const raw = document.querySelector("#cameraRawCanvas"), matched = document.querySelector("#cameraAnalysisCanvas");
    return raw?.dataset.frameId && raw.dataset.frameId === matched?.dataset.frameId &&
      raw.dataset.streamId === matched.dataset.streamId;
  });
  await shot("dense-camera.png");
  assert.deepEqual(report.timing.view, [1365, 900, 1]);
  assert.deepEqual(report.timing.audit, []);
  assert.deepEqual(report.timing.actors, { traffic: 96, pedestrians: 144 });
  assert.ok(report.timing.fps >= 25 && report.timing.ticksPerSecond >= 45 &&
    report.timing.renderP95Ms <= 75 && report.timing.latencyP95Ms <= 550 && report.timing.frames >= 18,
  JSON.stringify(report.timing));
}

try {
  if (mode === "density") await denseCity();
  else if (mode === "lead") {
    for (const side of [-1, 1]) {
      const smart = await fixture("crossing", side, "vision-first");
      const baseline = await fixture("crossing", side, "sensors-only");
      for (const item of [smart, baseline]) assert.deepEqual(item.audit, []);
      if (debug) {
        console.log(JSON.stringify({ side, lead: smart.lead, sensor: smart.sensor, entry: smart.entry, stop: smart.stop }));
        continue;
      }
      assert.ok(smart.evidence?.samePixels && smart.evidence.people.length && smart.evidence.model && smart.evidenceImage);
      assert.ok(smart.lead && smart.lead.age <= 750 && smart.lead.gap >= 6 && !smart.lead.inside);
      const { frameId, timeS, people, tracks } = smart.evidence;
      const track = tracks.find(item => item.id === smart.lead.evidenceId &&
        item.label === "person" && item.frameId === frameId);
      assert.ok(track && people.some(person => person.box.every((value, i) => value === track.box[i])),
        "The decision must name a track backed by a person box in the exact captured JPEG");
      const atCapture = smart.records.find(sample => sample.sceneTick === Math.round(timeS * 60));
      const footpoint = track.history.at(-1).position;
      assert.ok(atCapture && Math.hypot(atCapture.personX - footpoint.x, atCapture.personZ - footpoint.z) < 2,
        "The tracked footpoint must match the measured pedestrian at capture, not another image feature");
      assert.ok(smart.entry && smart.lead.tick < smart.entry.tick);
      assert.ok(baseline.entry && baseline.entry.actualMid >= -.5 && baseline.entry.actualMid <= 10,
        "The same person's entry must be near the sensor-only approach, not after the car has passed");
      assert.ok(!smart.sensor || smart.lead.tick < smart.sensor.tick);
      assert.ok(smart.stop && smart.stop.actualMid >= 3 &&
        (!smart.sensor || smart.stop.tick < smart.sensor.tick));
      assert.ok(baseline.records[smart.lead.tick + 5]?.speed > smart.records[smart.lead.tick + 5]?.speed + .2,
        "Under identical starting inputs the camera arm must physically slow earlier");
      assert.equal(baseline.lead, null);
    }
  } else {
    for (const kind of ["parallel", "stationary"]) {
      const smart = await fixture(kind, 1, "vision-first");
      const baseline = await fixture(kind, 1, "sensors-only");
      assert.ok(smart.frames.some(frame => frame.samePixels && frame.people.length),
        "Missing detections are not a successful non-crossing control");
      assert.equal(smart.lead, null);
      assert.ok(smart.records[210].x >= baseline.records[210].x - 3);
      assert.deepEqual(smart.audit, []);
    }
    const outage = await fixture("crossing", 1, "vision-first", true);
    assert.ok(outage.records.some(sample => !sample.available && sample.final === 0 && sample.speed < .05));
    assert.equal(outage.lead, null);
    assert.deepEqual(outage.audit, []);
    process.exitCode = 3;
  }
  assert.deepEqual(report.errors, []);
  report.passed = !debug;
} catch (error) {
  report.failure = error.stack;
  await shot("city-vision-failure.png");
  throw error;
} finally {
  await writeFile(join(output, "city-vision-lead.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
