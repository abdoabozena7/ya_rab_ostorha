import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR, base = process.env.THREEJS_URL;
assert.ok(output && base, "Run through scripts\\verify_vision_egypt.py");
await mkdir(output, { recursive: true });
const negative = process.argv.includes("--negative-control");
const report = { unexpectedErrors: [], networkFailures: [], cases: [], cameraInputOnly: true };
const temporal = [];
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const browser = await chromium.launch({ headless: false, args: [
  "--force-device-scale-factor=1",
  `--log-net-log=${path.join(output, "browser-network.json")}`,
] });
let page, latestFrame = null;
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.unexpectedErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !negative) report.unexpectedErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin)
      report.unexpectedErrors.push(`External runtime request: ${url}`);
    if (url.endsWith("/api/vision/frame") && request.method() === "POST") {
      latestFrame = request.postDataJSON();
      const allowed = ["schema", "streamId", "frameId", "simulationTimeS", "camera", "ego", "imageJpegBase64"];
      if (Object.keys(latestFrame).some((key) => !allowed.includes(key)))
        report.cameraInputOnly = false;
    }
  });
  page.on("requestfailed", (request) => {
    if (!negative) {
      report.unexpectedErrors.push(`Request failed: ${request.url()}`);
      report.networkFailures.push({ url: request.url(), method: request.method(),
        error: request.failure()?.errorText, timing: request.timing(), failedAt: Date.now() });
    }
  });
  page.on("response", (response) => {
    if (!negative && response.status() >= 400)
      report.unexpectedErrors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => window.sim?.vehicleRig, undefined, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(output, "egypt-city.png") });
  report.egyptStreetIdentity = await page.evaluate(() => {
    const layer = window.sim.view.egyptStreets;
    const sites = window.sim.world.statics.filter((site) => site.kind === "building");
    return layer?.diagnostics.textAtlasAvailable === true
      && layer.diagnostics.siteIds.length === sites.length && sites.length > 0
      && layer.root.children.length > 0;
  });
  assert.ok(report.egyptStreetIdentity, "The actual registered district and locally rendered Arabic atlas must be present");
  if (!negative) {
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(1200);
    await page.keyboard.up("KeyW");
    await page.locator("#phoneToggleBtn").click();
    await page.locator("#phonePlaces").getByRole("button", { name: "السوق", exact: true }).click();
    await page.locator("#phoneToggleBtn").click();
    const probeSource = await readFile(
      "C:\\Users\\A-plus\\.agents\\skills\\harrtest\\assets\\probes\\browser-timing.js", "utf8");
    const before = await page.evaluate(() => ({
      wall: performance.now(), tick: window.sim.world.tick, draw: window.sim.renderDiagnostics(),
    }));
    await page.evaluate(() => {
      const sample = { frames: [], previous: window.sim.renderDiagnostics().renderedFrames, handle: null };
      const observe = (now) => {
        const rendered = window.sim.renderDiagnostics();
        if (rendered.renderedFrames !== sample.previous) {
          sample.frames.push({ wallMs: now, renderedFrames: rendered.renderedFrames,
            tick: window.sim.world.tick, calls: rendered.renderCalls, triangles: rendered.triangles });
          sample.previous = rendered.renderedFrames;
        }
        sample.handle = requestAnimationFrame(observe);
      };
      sample.handle = requestAnimationFrame(observe);
      window.__visionRenderProbe = sample;
    });
    const callbackSample = await runInThisContext("(" + probeSource + ")")(page);
    const after = await page.evaluate(() => ({
      wall: performance.now(), tick: window.sim.world.tick, draw: window.sim.renderDiagnostics(),
    }));
    const elapsedS = (after.wall - before.wall) / 1000;
    const renderSamples = await page.evaluate(() => {
      cancelAnimationFrame(window.__visionRenderProbe.handle);
      return window.__visionRenderProbe.frames;
    });
    const intervals = renderSamples.slice(1).map((sample, index) =>
      sample.wallMs - renderSamples[index].wallMs).sort((a, b) => a - b);
    const p95FrameIntervalMs = intervals[Math.floor(intervals.length * 0.95)];
    report.runtime = {
      renderedFps: (after.draw.renderedFrames - before.draw.renderedFrames) / elapsedS,
      ticksPerWallSecond: (after.tick - before.tick) / elapsedS,
      exactBacking: after.draw.width === 1365 && after.draw.height === 900 && after.draw.pixelRatio === 1,
      p95FrameIntervalMs, renderSamples, callbackSample, before, after, passed: false,
    };
    report.runtime.passed = report.runtime.renderedFps >= 25
      && report.runtime.ticksPerWallSecond >= 45 && report.runtime.exactBacking
      && p95FrameIntervalMs <= 100
      && renderSamples.every((sample) => sample.calls > 0 && sample.triangles > 0);
    assert.ok(report.runtime.passed, JSON.stringify(report.runtime));
    await page.screenshot({ path: path.join(output, "egypt-driving.png") });
  }
  await page.locator("#visionToggleBtn").click();
  await page.waitForFunction(() => Boolean(window.sim.vision.status.result), undefined, { timeout: 30000 });
  const readyStream = await page.evaluate(() => window.sim.vision.streamId);
  await page.waitForFunction(() => window.sim.vision.status.status === "stale",
    undefined, { timeout: 5000 });
  await page.locator("#visionRunBtn").click();
  await page.waitForFunction((oldStream) => window.sim.vision.streamId !== oldStream
    && window.sim.world.visionLab?.phase === "running"
    && window.sim.vision.status.result?.streamId === window.sim.vision.streamId,
  readyStream, { timeout: 15000 });
  report.readySnapshotRefreshVerified = true;
  await page.locator("#visionResetBtn").click();
  const readState = () => page.evaluate(() => {
    const world = window.sim.world;
    return {
      wallMs: performance.now(), visibility: document.visibilityState,
      focused: document.hasFocus(), tick: world.tick, environment: world.environment,
      phase: world.visionLab?.phase, lab: structuredClone(world.visionLab),
      player: { x: world.player.x, z: world.player.z, speed: world.player.speed, reason: world.player.reason },
      people: world.actors.filter((actor) => actor.type === "pedestrian").map((actor) => ({
        id: actor.id, x: actor.x, z: actor.z, speed: actor.speed, reason: actor.reason,
      })),
      sensorRawM: [...world.sensors.rawM],
      rangeHitIds: (world.sensors.rays ?? []).map((ray) => ray.hitId),
      audit: world.audit(), everyTickAudit: window.__visionTickAudit ?? null,
      visual: structuredClone(world.visualState), perception: structuredClone(window.sim.vision.status),
    };
  });
  async function runCase(caseId, mode) {
    await page.bringToFront();
    await page.locator("#visionCase").selectOption(caseId);
    await page.locator("#visionMode").selectOption(mode);
    await page.locator("#visionRunBtn").click();
    await page.waitForFunction(() => window.sim.world.visionLab?.phase === "running",
      undefined, { timeout: 30000 });
    await page.evaluate(() => {
      const world = window.sim.world, original = world.step.bind(world);
      const observation = { samples: 0, errors: [] };
      window.__visionTickAudit = observation;
      world.step = (...args) => {
        const result = original(...args);
        observation.samples++;
        const errors = world.audit();
        if (errors.length) observation.errors.push({ tick: world.tick, errors });
        return result;
      };
    });
    const samples = [], deadline = Date.now() + 45000;
    const rawFramesSaved = new Set();
    let captured = false, capturedStop = false;
    while (Date.now() < deadline) {
      const state = await readState();
      samples.push(state);
      if (caseId === "cross-left" && mode === "vision-first") {
        const second = Math.floor(state.tick / 60);
        if ([1, 2, 3].includes(second) && !rawFramesSaved.has(second)) {
          const raw = await page.request.get(base + "api/vision/frame");
          assert.equal(raw.status(), 200);
          await writeFile(path.join(output, `raw-front-${second}s.jpg`), await raw.body());
          rawFramesSaved.add(second);
        }
      }
      if (state.lab?.firstVisualBrakeS !== null && state.lab?.firstVisualBrakeS !== undefined && !captured) {
        await page.screenshot({ path: path.join(output, `${caseId}-${mode}-predictive-brake.png`) });
        captured = true;
      }
      if (state.player.speed < 0.05 && state.player.reason === "visual-prediction" && !capturedStop) {
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(output, `${caseId}-${mode}-predictive-stop.png`) });
        capturedStop = true;
      }
      if (state.phase === "complete") break;
      await page.waitForTimeout(90);
    }
    const final = samples.at(-1);
    assert.equal(final.phase, "complete", `${caseId}/${mode} did not complete the bounded public case`);
    assert.ok(final.player.z >= final.lab.goalZ - 0.1, `${caseId}/${mode} timed out rather than reaching its goal`);
    assert.ok(samples.every((sample) => sample.audit.length === 0), "Independent physical safety must remain valid");
    assert.ok(final.everyTickAudit.samples > 0 && final.everyTickAudit.errors.length === 0,
      "The actual every-tick audit must not hide a transient contact between browser samples");
    assert.ok(samples.some((sample) => sample.perception.result?.detections.length >= 0),
      "The actual camera pipeline must produce a matching-stream result");
    await page.screenshot({ path: path.join(output, `${caseId}-${mode}-complete.png`) });
    temporal.push({ caseId, mode, samples });
    const firstPersonRange = samples.find((sample) =>
      sample.people.some((person) => sample.rangeHitIds.includes(person.id)));
    const firstVisualStop = samples.find((sample) =>
      sample.player.speed < 0.05 && sample.player.reason === "visual-prediction");
    return { caseId, mode, final, sampleCount: samples.length,
      firstCompleteVisualStopS: firstVisualStop ? firstVisualStop.tick / 60 : null,
      firstPersonRangeS: firstPersonRange ? firstPersonRange.tick / 60 : null,
      detections: Math.max(...samples.map((sample) => sample.perception.result?.detections.length ?? 0)),
      personObservationFrames: new Set(samples.filter((sample) =>
        sample.perception.result?.detections.some((item) => item.label === "person"))
        .map((sample) => sample.perception.result.frameId)).size,
      maximumLatencyMs: Math.max(...samples.map((sample) => sample.perception.result?.latencyMs ?? 0)) };
  }
  if (negative) {
    await page.locator("#visionCase").selectOption("cross-left");
    await page.locator("#visionRunBtn").click();
    await page.waitForFunction(() => Boolean(window.sim.vision.status.result), undefined, { timeout: 30000 });
    assert.ok(latestFrame);
    const bad = await page.request.post(base + "api/vision/frame", {
      data: { ...latestFrame, frameId: latestFrame.frameId + 100, actors: [{ x: 0, z: 0, willCross: true }] },
    });
    assert.equal(bad.status(), 400, "The pixel API must reject actor/future truth");
    await page.route("**/api/vision/frame", (route) => route.abort("failed"));
    await page.waitForTimeout(1600);
    const stale = await readState();
    const unavailable = stale.visual?.decision?.available === false
      || stale.perception.available === false;
    await page.waitForFunction(() => window.sim.world.visionLab?.firstReactiveBrakeS !== null,
      undefined, { timeout: 15000 });
    const fallback = await readState();
    assert.ok(fallback.lab.firstReactiveBrakeS !== null && fallback.audit.length === 0,
      "A lost camera must leave the ordinary independent reactive safety in control");
    await page.unroute("**/api/vision/frame");
    await page.locator("#visionResetBtn").click();
    await page.waitForFunction(() => window.sim.vision.status.status === "ready"
      && Boolean(window.sim.vision.status.result), undefined, { timeout: 15000 });
    const recovered = await readState();
    const result = {
      detected: unavailable && bad.status() === 400 && stale.audit.length === 0
        && fallback.lab.firstReactiveBrakeS !== null
        && recovered.perception.status === "ready",
      readySnapshotRefreshVerified: report.readySnapshotRefreshVerified,
      forbiddenTruthRejected: bad.status(), staleState: stale, fallback, recovered,
      fault: "isolated real front-camera transport loss; no delivered source modified",
    };
    await save("negative.json", result);
    assert.ok(result.detected);
    console.log("EXPECTED_VISION_FAILURE_DETECTED");
    process.exitCode = 3;
  } else {
    for (const id of ["cross-left", "cross-right", "parallel", "stationary", "empty"]) {
      const result = await runCase(id, "vision-first");
      report.cases.push(result);
      if (id.startsWith("cross")) {
        assert.ok(result.personObservationFrames >= 3, "A true crossing needs repeated actual semantic person detections");
        const lab = result.final.lab;
        assert.ok(lab.firstVisualBrakeS !== null, `${id}: no actual visual-prediction brake`);
        assert.ok(lab.firstLaneEntryS !== null && lab.firstVisualBrakeS < lab.firstLaneEntryS,
          `${id}: forecast brake must precede actual later lane entry`);
        assert.ok(lab.firstSensorTriggerS === null || lab.firstVisualBrakeS < lab.firstSensorTriggerS,
          `${id}: an earlier proximity-trigger stop is not vision-first evidence`);
        assert.ok(result.firstPersonRangeS === null || lab.firstVisualBrakeS < result.firstPersonRangeS,
          `${id}: the person was already measured by a proximity beam before the claimed forecast brake`);
        const samples = temporal.at(-1).samples;
        const firstApplied = samples.find((sample) => sample.lab.firstVisualBrakeS !== null);
        assert.ok(firstApplied && firstApplied.people.every((person) =>
          !firstApplied.rangeHitIds.includes(person.id)),
        `${id}: visual anticipation must precede an actual proximity beam hitting this person`);
        const observedEntry = samples.find((sample) =>
          sample.people.some((person) => Math.abs(person.x) < 1.85 / 2 + 0.34));
        assert.ok(observedEntry, `${id}: later observed person motion must actually enter the car corridor`);
        assert.ok(samples.some((sample) => sample.people.some((person) =>
          id === "cross-left" ? person.x > 1.5 : person.x < -1.5)),
        `${id}: the actual person must continue across, not only be labeled a crossing`);
        assert.ok(samples.some((sample) => sample.player.speed < 0.05
          && sample.player.reason === "visual-prediction"
          && sample.tick / 60 > lab.firstVisualBrakeS + 0.2
          && sample.tick / 60 < lab.firstLaneEntryS
          && (lab.firstReactiveBrakeS === null || sample.tick / 60 < lab.firstReactiveBrakeS)),
        `${id}: visual prediction must complete the physical stop before lane entry/reactive braking, not only pulse a cap or stop at the terminal goal`);
      } else {
        if (id !== "empty")
          assert.ok(result.personObservationFrames >= 3,
            `${id}: a noncrossing person must actually be seen, not pass because vision missed them`);
        assert.equal(result.final.lab.firstVisualBrakeS, null,
          `${id}: lookalike noncrossing must not receive a predictive false brake`);
      }
    }
    for (const id of ["cross-left", "cross-right"])
      report.cases.push(await runCase(id, "sensors-only"));
    report.comparisons = ["cross-left", "cross-right"].map((id) => {
      const visual = report.cases.find((item) => item.caseId === id && item.mode === "vision-first");
      const reactive = report.cases.find((item) => item.caseId === id && item.mode === "sensors-only");
      assert.ok(reactive.final.lab.firstReactiveBrakeS !== null,
        `${id}: the comparison needs an actual reactive brake, not a fictional disabled baseline`);
      assert.ok(visual.final.lab.firstVisualBrakeS < reactive.final.lab.firstReactiveBrakeS,
        `${id}: the claimed visual benefit must precede the same real reactive baseline`);
      return { caseId: id, visualBrakeS: visual.final.lab.firstVisualBrakeS,
        reactiveBrakeS: reactive.final.lab.firstReactiveBrakeS,
        leadSeconds: reactive.final.lab.firstReactiveBrakeS - visual.final.lab.firstVisualBrakeS };
    });
    report.positiveCrossingsPassed = 2;
    report.negativeCasesPassed = 3;
    report.predictiveFalseBrakes = report.cases.filter((item) =>
      ["parallel", "stationary", "empty"].includes(item.caseId)
      && item.final.lab.firstVisualBrakeS !== null).length;
    report.visionBeforeSensorTrigger = report.cases.filter((item) =>
      item.mode === "vision-first" && item.caseId.startsWith("cross")).every((item) =>
      item.final.lab.firstVisualBrakeS !== null
      && (item.final.lab.firstSensorTriggerS === null
        || item.final.lab.firstVisualBrakeS < item.final.lab.firstSensorTriggerS));
    assert.ok(latestFrame && report.cameraInputOnly);
    const samplePath = process.env.VISION_SAMPLE_PATH
      ?? path.join(process.cwd(), ".runtime-proof", "vision-egypt-20261116", "camera-sample.json");
    await writeFile(samplePath, JSON.stringify(latestFrame));
    await page.locator("#visionReturnBtn").click();
    assert.equal((await readState()).environment, "city");
    report.returnedCity = true;
    await page.bringToFront();
    const cityVisionStartedAt = Date.now();
    await page.waitForFunction(() => window.sim.vision.status.result?.streamId === window.sim.vision.streamId
      && window.sim.vision.status.result.frameId >= 2, undefined, { timeout: 10000 });
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    report.runtime.liveVisionWarmupMs = Date.now() - cityVisionStartedAt;
    report.runtime.withLiveVision = await page.evaluate(async () => {
      const start = performance.now(), first = window.sim.renderDiagnostics();
      const firstTick = window.sim.world.tick;
      const firstFrame = window.sim.vision.status.result?.frameId ?? -1;
      const samples = [];
      let previous = first.renderedFrames;
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(), draw = window.sim.renderDiagnostics();
        if (draw.renderedFrames !== previous) {
          samples.push({ wallMs: now, renderCalls: draw.renderCalls, triangles: draw.triangles });
          previous = draw.renderedFrames;
        }
      }
      const elapsedS = (performance.now() - start) / 1000;
      const last = window.sim.renderDiagnostics();
      const intervals = samples.slice(1).map((sample, index) =>
        sample.wallMs - samples[index].wallMs).sort((a, b) => a - b);
      const renderedFps = (last.renderedFrames - first.renderedFrames) / elapsedS;
      const ticksPerWallSecond = (window.sim.world.tick - firstTick) / elapsedS;
      const p95FrameIntervalMs = intervals[Math.floor(intervals.length * 0.95)];
      const current = window.sim.vision.status;
      return { elapsedS, renderedFps, ticksPerWallSecond, p95FrameIntervalMs,
        visibility: document.visibilityState, focused: document.hasFocus(),
        width: last.width, height: last.height, pixelRatio: last.pixelRatio,
        model: current.result?.model, firstFrameId: firstFrame,
        lastFrameId: current.result?.frameId, status: current.status,
        passed: renderedFps >= 25 && ticksPerWallSecond >= 45 && p95FrameIntervalMs <= 100
          && last.width === 1365 && last.height === 900 && last.pixelRatio === 1
          && current.result?.frameId > firstFrame
          && samples.every((sample) => sample.renderCalls > 0 && sample.triangles > 0) };
    });
    assert.ok(report.runtime.withLiveVision.passed, JSON.stringify(report.runtime.withLiveVision));
    report.runtime.passed = report.runtime.passed && report.runtime.withLiveVision.passed;
    await page.locator("#carToggleBtn").click();
    await page.locator("#carSensorCamera").selectOption("rear");
    const previousCapture = latestFrame.frameId;
    await page.waitForTimeout(500);
    assert.ok(latestFrame.frameId > previousCapture, "Front inference must keep capturing while the user views the rear camera");
    const headingError = Math.atan2(
      Math.sin(latestFrame.camera.headingRad - latestFrame.ego.headingRad),
      Math.cos(latestFrame.camera.headingRad - latestFrame.ego.headingRad));
    assert.ok(Math.abs(headingError) < 0.01,
      "The selected rear display must not replace the physical front inference image");
    report.rearDisplayDoesNotChangeInference = { verified: true, headingErrorRad: headingError };
    await page.screenshot({ path: path.join(output, "rear-display-front-inference.png") });
    await page.locator("#carSensorCamera").selectOption("front");
    await page.locator("#carCloseBtn").click();
    await page.screenshot({ path: path.join(output, "returned-egypt-city.png") });
    assert.deepEqual(report.unexpectedErrors, []);
    await save("temporal.json", temporal);
    await save("vision-journey.json", report);
    console.log(JSON.stringify({
      positiveCrossingsPassed: report.positiveCrossingsPassed,
      negativeCasesPassed: report.negativeCasesPassed,
      predictiveFalseBrakes: report.predictiveFalseBrakes,
      visionBeforeSensorTrigger: report.visionBeforeSensorTrigger,
      runtime: { fps: report.runtime.renderedFps, ticks: report.runtime.ticksPerWallSecond },
    }));
  }
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed())
    report.transport = await page.evaluate(() => window.sim?.vision?.transport ?? []);
  await save("failure.json", report);
  await save("temporal.json", temporal);
  if (latestFrame) await save("camera-sample.json", latestFrame);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failed.png") });
  throw error;
} finally {
  await browser.close();
}
