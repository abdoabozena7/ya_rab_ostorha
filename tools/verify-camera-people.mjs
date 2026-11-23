import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR, base = process.env.THREEJS_URL;
assert.ok(output && base, "Run through scripts\\verify_camera_people.py");
await mkdir(output, { recursive: true });
const negative = process.argv.includes("--negative-control");
const report = { unexpectedErrors: [], expectedErrors: [], camera: {}, people: {} };
const temporal = [];
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
let page, latestFrame, withholding = false, inferencePosts = 0;
const withheldRequests = new Set();
const shot = (name, clip) => page.screenshot({ path: path.join(output, name), ...(clip ? { clip } : {}) });
try {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1,
    recordVideo: { dir: path.join(output, "video"), size: { width: 1365, height: 900 } },
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.unexpectedErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (withholding && message.text().includes("net::ERR_BLOCKED_BY_CLIENT"))
      report.expectedErrors.push(message.text());
    else report.unexpectedErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (withheldRequests.delete(request) && request.url().endsWith("/api/vision/frame")
      && /^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/.test(request.failure()?.errorText ?? ""))
      report.expectedErrors.push(`Withheld real camera: ${request.url()}`);
    else report.unexpectedErrors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin)
      report.unexpectedErrors.push(`External runtime request: ${request.url()}`);
    if (request.method() === "POST" && /\/api\/vision\/(?:start|frame)$/.test(request.url()))
      inferencePosts++;
    if (request.url().endsWith("/api/vision/frame") && request.method() === "POST") {
      latestFrame = request.postDataJSON();
      const allowed = ["schema", "streamId", "frameId", "simulationTimeS", "camera", "ego", "imageJpegBase64"];
      assert.deepEqual(Object.keys(latestFrame).sort(), allowed.sort(),
        "Only real pixels, calibration, own odometry and frame identity may reach inference");
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => window.sim?.vehicleRig, undefined, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await clickCityTool(page, "cameraScreenToggleBtn");
  await page.waitForFunction(() => {
    const raw = document.querySelector("#cameraRawCanvas");
    return !document.querySelector("#cameraScreen").hidden && Number(raw.dataset.frameId) > 0;
  });
  report.camera.rawPreviewContinuity = await page.evaluate(async () => {
    const raw = document.querySelector("#cameraRawCanvas"), start = performance.now();
    const firstFrame = Number(raw.dataset.frameId);
    let frames = 0, hiddenFrames = 0;
    while (performance.now() - start < 1000) {
      await new Promise(requestAnimationFrame);
      frames++;
      if (raw.hidden || !raw.dataset.frameId) hiddenFrames++;
    }
    return { elapsedMs: performance.now() - start, frames, hiddenFrames,
      firstFrame, lastFrame: Number(raw.dataset.frameId) };
  });
  assert.ok(report.camera.rawPreviewContinuity.frames > 15);
  assert.equal(report.camera.rawPreviewContinuity.hiddenFrames, 0,
    "Ordinary detector-off refresh must not blank the completed raw camera image");
  assert.ok(report.camera.rawPreviewContinuity.lastFrame > report.camera.rawPreviewContinuity.firstFrame);
  assert.equal(inferencePosts, 0, "Opening raw preview must not secretly submit/start inference");
  await shot("camera-raw-preview.png");
  assert.equal(await page.evaluate(() => window.sim.vision.status.status), "disabled");
  report.camera.rawPreviewWithoutInference = true;
  await page.locator("#cameraPerceptionStartBtn").click();
  await page.waitForFunction(() => window.sim.vision.status.status === "ready"
    && window.sim.vision.status.result?.streamId === window.sim.vision.streamId,
  undefined, { timeout: 30000 });
  report.camera.realPixelInference = true;

  if (negative) {
    assert.ok(latestFrame);
    const invalid = await page.request.post(base + "api/vision/frame", {
      data: { ...latestFrame, frameId: latestFrame.frameId + 1000,
        actors: [{ id: "forbidden-truth", x: 0, z: 0, willCross: true }] },
    });
    assert.equal(invalid.status(), 400);
    const actualEvidence = await page.evaluate(() => {
      const { frame, status, state } = window.sim.vision;
      const result = status.result;
      return { frame, result, visual: state?.streamId === result?.streamId
        && state?.frameId === result?.frameId ? state : null, availability: status };
    });
    assert.ok(actualEvidence.frame && actualEvidence.result);
    const fixture = await context.newPage();
    await fixture.route("**/camera-frame-negative", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Negative control: mismatched camera frame</title><nav></nav>",
    }));
    await fixture.goto(base + "camera-frame-negative");
    const mismatched = await fixture.evaluate(async ({ baseUrl, evidence }) => {
      const { mountCameraScreen } = await import(baseUrl + "src/ui/camera-screen.js");
      const screen = mountCameraScreen({ navigation: document.querySelector("nav"),
        onAction: async () => ({ ok: true }), onVisibilityChange() {} });
      document.querySelector("#cameraScreenToggleBtn").click();
      const state = { ...evidence, enabled: true, ego: { speedMps: 0 },
        applied: { reason: "negative-control" } };
      screen.update(state);
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline
          && document.querySelector("#cameraAnalysisCanvas").dataset.frameId !== String(evidence.result.frameId))
        await new Promise((resolve) => setTimeout(resolve, 10));
      const previouslyPainted = document.querySelector("#cameraAnalysisCanvas").dataset.frameId
        === String(evidence.result.frameId);
      if (!previouslyPainted) throw new Error("The mismatch control never established a real complete image pair");
      screen.update({ ...state,
        frame: { ...evidence.frame, frameId: evidence.result.frameId + 100 } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const status = document.querySelector("#cameraScreenStatus").textContent;
      const raw = document.querySelector("#cameraRawCanvas");
      const analysis = document.querySelector("#cameraAnalysisCanvas");
      const result = { status, previouslyPainted, analysisHidden: analysis.hidden,
        rawFrame: raw.dataset.frameId ?? null,
        analysisFrame: analysis.dataset.frameId ?? null,
        claimedMatchingResult: analysis.dataset.frameId === String(evidence.result.frameId) };
      screen.dispose();
      return result;
    }, { baseUrl: base, evidence: actualEvidence });
    assert.equal(mismatched.claimedMatchingResult, false,
      "A different JPEG cannot inherit a current neural result in the actual screen module");
    assert.equal(mismatched.analysisHidden, true,
      "A mismatched input must invalidate the previous visible interpretation, not only its identity tags");
    await fixture.close();
    await page.bringToFront();
    withholding = true;
    await page.route("**/api/vision/frame", (route) => {
      withheldRequests.add(route.request());
      return route.abort("blockedbyclient");
    });
    await page.waitForFunction(() => window.sim.vision.status.status === "stale"
      && document.querySelector("#cameraAnalysisCanvas").hidden,
      undefined, { timeout: 15000 });
    await page.waitForTimeout(250);
    const unavailable = await page.evaluate(() => ({
      status: document.querySelector("#cameraScreenStatus").textContent,
      visualAvailable: window.sim.vision.state?.decision?.available ?? false,
      sourceAgeMs: window.sim.vision.state?.ageMs,
      analysisHidden: document.querySelector("#cameraAnalysisCanvas").hidden,
      backend: window.sim.vision.status.status,
    }));
    assert.equal(unavailable.visualAvailable, false);
    assert.ok(unavailable.sourceAgeMs > 750 && unavailable.analysisHidden);
    await shot("camera-unavailable-negative.png");
    const failedStream = await page.evaluate(() => window.sim.vision.streamId);
    await page.locator("#cameraPerceptionStartBtn").click();
    await page.waitForFunction((previous) => window.sim.vision.streamId !== previous,
      failedStream, { timeout: 15000 });
    await page.unroute("**/api/vision/frame");
    withholding = false;
    await page.waitForFunction(() => window.sim.vision.status.status === "ready"
      && window.sim.vision.status.result?.streamId === window.sim.vision.streamId,
    undefined, { timeout: 30000 });
    await page.locator("#cameraScreenCloseBtn").click();
    await clickCityTool(page, "settingsBtn");
    await page.locator("#settingsForm input[name=pedestrians]").focus();
    await page.keyboard.press("Home");
    await page.locator("#settingsForm button[type=submit]").click();
    await page.locator("#closeSettings").click();
    await clickCityTool(page, "peopleToggleBtn");
    await page.waitForFunction(() => document.querySelector("#peopleSelect").disabled);
    const empty = await page.locator("#peopleStatus").textContent();
    assert.equal(await page.locator("#peopleFocusBtn").isDisabled(), true);
    const result = { detected: true, forbiddenTruthRejected: invalid.status(),
      mismatchDisplay: mismatched, mismatchedEvidenceClass: "isolated display-boundary negative using actual retained camera data",
      unavailable, recovered: true, emptyPeopleStatus: empty,
      unexpectedErrors: report.unexpectedErrors, expectedErrors: report.expectedErrors };
    assert.deepEqual(report.unexpectedErrors, []);
    await save("negative.json", result);
    console.log("EXPECTED_CAMERA_PEOPLE_FAILURE_DETECTED");
    process.exitCode = 3;
  } else {
    await page.locator("#cameraScreenCloseBtn").click();
    await clickCityTool(page, "peopleToggleBtn");
    const selected = await page.evaluate(() => {
      const w = window.sim.world;
      return w.actors.filter((actor) => actor.type === "pedestrian" && !actor.crossing
        && actor.pause === 0 && Math.hypot(actor.x - actor.target.x, actor.z - actor.target.z) > 10)
        .sort((a, b) => Math.hypot(a.x - w.player.x, a.z - w.player.z)
          - Math.hypot(b.x - w.player.x, b.z - w.player.z))[0]?.id;
    });
    assert.ok(selected, "Use an actual ordinary walking person, not a hidden pose fixture");
    await page.locator("#peopleSelect").selectOption(selected);
    await page.locator("#peopleFocusBtn").click();
    await page.waitForFunction((id) => window.sim.people.focusedId === id, selected);
    await page.evaluate((id) => {
      const w = window.sim.world, original = w.step.bind(w);
      window.__peopleMotion = [];
      window.__peopleGait = [];
      let previousSampleMs = -Infinity;
      const sampleGait = (now) => {
        if (now - previousSampleMs >= 150) {
          const bones = [];
          window.sim.view.roots.get(id)?.visual?.traverse((part) => {
            if (part.isBone && /leg|thigh|calf|arm|shin/i.test(part.name) && bones.length < 8)
              bones.push({ name: part.name, quaternion: part.quaternion.toArray() });
          });
          const person = w.actors.find((actor) => actor.id === id);
          window.__peopleGait.push({ wallMs: now, tick: w.tick, speed: person.speed,
            distance: person.distance, mode: person.motionMode, rig: window.sim.people.rig, bones });
          previousSampleMs = now;
        }
        window.__peopleGaitHandle = requestAnimationFrame(sampleGait);
      };
      window.__peopleGaitHandle = requestAnimationFrame(sampleGait);
      w.step = (...args) => {
        const result = original(...args), person = w.actors.find((actor) => actor.id === id);
        window.__peopleMotion.push({ tick: w.tick, x: person.x, z: person.z,
          speed: person.speed, heading: person.heading, distance: person.distance,
          reason: person.reason, motionMode: person.motionMode,
          accelerationMps2: person.accelerationMps2, body: person.body });
        return result;
      };
    }, selected);
    await page.locator("#peopleMotionMode").selectOption("stop");
    await page.waitForFunction((id) => window.sim.world.actors.find((actor) => actor.id === id).speed < 0.01,
      selected, { timeout: 6000 });
    await page.waitForTimeout(200);
    await shot("person-stopped.png");
    await page.locator("#peopleMotionMode").selectOption("walk");
    await page.waitForFunction((id) => window.sim.world.actors.find((actor) => actor.id === id).speed > 0.6,
      selected, { timeout: 6000 });
    await page.waitForTimeout(700);
    await shot("person-walking.png");
    await page.locator("#peopleMotionMode").selectOption("jog");
    await page.waitForFunction((id) => {
      const p = window.sim.world.actors.find((actor) => actor.id === id);
      return p.speed > p.body.walkSpeedMps + 0.2;
    }, selected, { timeout: 8000 });
    await page.waitForTimeout(400);
    await shot("person-jogging.png");
    report.camera.frontLensWhileFollowingPerson = await page.evaluate(() => {
      const { camera, ego } = window.sim.vision.frame;
      return {
        positionErrorM: Math.hypot(camera.position.x - ego.x - Math.sin(ego.headingRad) * .72,
          camera.position.z - ego.z - Math.cos(ego.headingRad) * .72),
        headingErrorRad: Math.atan2(Math.sin(camera.headingRad - ego.headingRad),
          Math.cos(camera.headingRad - ego.headingRad)),
        heightM: camera.position.y,
      };
    });
    assert.ok(report.camera.frontLensWhileFollowingPerson.positionErrorM < 1e-6);
    assert.ok(Math.abs(report.camera.frontLensWhileFollowingPerson.headingErrorRad) < 1e-6);
    await page.locator("#pauseBtn").click();
    await page.waitForTimeout(200);
    const paused = await page.evaluate(() => ({ tick: window.sim.world.tick, rig: window.sim.people.rig }));
    await page.waitForTimeout(500);
    const pausedAgain = await page.evaluate(() => ({ tick: window.sim.world.tick, rig: window.sim.people.rig }));
    assert.equal(pausedAgain.tick, paused.tick);
    for (const key of ["motion", "gait", "clips"])
      assert.deepEqual(pausedAgain.rig[key], paused.rig[key],
        "Paused accepted time/distance must not keep walking the skeleton");
    for (const key of ["minFootYM", "maxFootYM", "offsetM"])
      assert.ok(Math.abs(pausedAgain.rig.ground[key] - paused.rig.ground[key]) < 1e-9,
        "Grounding may have numeric roundoff, not measurable paused movement");
    await shot("person-body-detail.png", { x: 390, y: 180, width: 450, height: 600 });
    const body = await page.evaluate((id) => {
      const record = window.sim.view.roots.get(id);
      record.visual.traverse((part) => {
        if (part.isSkinnedMesh) { part.skeleton.update(); part.computeBoundingBox(); }
      });
      return { actor: structuredClone(window.sim.world.actors.find((actor) => actor.id === id)),
        rig: window.sim.people.rig, articulated: record.visual.getObjectsByProperty("isSkinnedMesh", true).length };
    }, selected);
    assert.ok(body.articulated > 0 && body.rig, "The primary person must be the actual locally installed articulated model");
    const gait = await page.evaluate(() => {
      cancelAnimationFrame(window.__peopleGaitHandle);
      return window.__peopleGait;
    });
    const observedBones = gait.filter((sample) => sample.speed > 0.6 && sample.bones.length > 0);
    assert.ok(observedBones.length >= 3, "Actual articulated motion needs temporal bone evidence");
    assert.ok(new Set(observedBones.map((sample) => JSON.stringify(sample.bones))).size >= 3,
      "Moving accepted poses cannot be represented by a frozen or missing skeleton");
    report.people.gaitObservationCount = gait.length;
    report.people.gaitEvidence = gait;
    temporal.push(...await page.evaluate(() => window.__peopleMotion));
    const moving = temporal.filter((sample) => sample.speed > 0.05);
    assert.ok(moving.length > 10);
    for (let i = 1; i < temporal.length; i++) {
      const previous = temporal[i - 1], current = temporal[i];
      if (current.tick === previous.tick) continue;
      const dt = (current.tick - previous.tick) / 60;
      const displacement = Math.hypot(current.x - previous.x, current.z - previous.z);
      assert.ok(Math.abs(current.distance - previous.distance - displacement) < 1e-8);
      const yaw = Math.abs(Math.atan2(Math.sin(current.heading - previous.heading),
        Math.cos(current.heading - previous.heading)));
      assert.ok(yaw <= current.body.maxTurnRateRadS * dt + 1e-8);
      const acceleration = (current.speed - previous.speed) / dt;
      if (!["occupied", "road-boundary", "blocked"].includes(current.reason)) {
        assert.ok(acceleration <= current.body.maxAccelerationMps2 + 1e-7);
        assert.ok(acceleration >= -current.body.maxDecelerationMps2 - 1e-7);
      }
    }
    report.people.publicMotionVerified = true;
    report.people.selectedId = selected;
    report.people.body = body;
    report.people.pausedGaitVerified = true;
    await page.setViewportSize({ width: 900, height: 650 });
    await shot("people-compact.png");
    const peopleBounds = await page.locator("#peoplePanel").boundingBox();
    assert.ok(peopleBounds.x >= 0 && peopleBounds.x + peopleBounds.width <= 900);
    await page.setViewportSize({ width: 1365, height: 900 });
    const alternate = await page.evaluate((id) => {
      const current = window.sim.world.actors.find((actor) => actor.id === id);
      return window.sim.world.actors.find((actor) => actor.type === "pedestrian" && actor.kind !== current.kind)?.id;
    }, selected);
    assert.ok(alternate);
    await page.locator("#peopleSelect").selectOption(alternate);
    await page.locator("#peopleFocusBtn").click();
    await page.waitForTimeout(200);
    await shot("person-alternate-body.png");
    await shot("person-alternate-detail.png", { x: 390, y: 180, width: 450, height: 600 });
    await page.locator("#peopleSelect").selectOption(selected);
    await page.locator("#peopleFocusBtn").click();
    await page.locator("#peopleMotionMode").selectOption("ambient");
    await page.locator("#pauseBtn").click();
    await page.waitForFunction((id) => {
      const person = window.sim.world.actors.find((actor) => actor.id === id);
      return person.motionMode === "ambient" && person.speed <= person.walkSpeed + 0.1;
    }, selected);
    await page.waitForTimeout(300);
    await shot("person-ambient-resumed.png");
    await page.locator("#pauseBtn").click();
    temporal.length = 0;
    temporal.push(...await page.evaluate(() => window.__peopleMotion));
    report.people.ambientResumeVerified = true;
    await page.locator("#peopleVehicleViewBtn").click();
    await page.locator("#peopleCloseBtn").click();
    assert.equal(await page.evaluate(() => window.sim.people.focusedId), null);
    const beforeReplay = await page.evaluate((id) => {
      const p = window.sim.world.actors.find((actor) => actor.id === id);
      return { tick: window.sim.world.tick, x: p.x, z: p.z, heading: p.heading,
        speed: p.speed, distance: p.distance, body: p.body, motionMode: p.motionMode };
    }, selected);
    await clickCityTool(page, "settingsBtn");
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#replayBtn").click();
    const download = await downloadEvent, replayPath = path.join(output, "public-people-replay.json");
    await download.saveAs(replayPath);
    const replay = JSON.parse(await readFile(replayPath, "utf8"));
    assert.ok(replay.events.filter((event) => event.command.type === "pedestrian-motion").length >= 3);
    await page.locator("#replayFile").setInputFiles(replayPath);
    await page.waitForFunction(() => document.querySelector("#replayProgress").textContent
      .includes("Replay restored"), undefined, { timeout: 60000 });
    const afterReplay = await page.evaluate((id) => {
      const p = window.sim.world.actors.find((actor) => actor.id === id);
      return { tick: window.sim.world.tick, x: p.x, z: p.z, heading: p.heading,
        speed: p.speed, distance: p.distance, body: p.body, motionMode: p.motionMode };
    }, selected);
    assert.deepEqual(afterReplay, beforeReplay, "The actual public replay import must reproduce accepted human motion");
    report.people.replayVerified = true;
    await page.locator("#closeSettings").click();
    await page.locator("#pauseBtn").click();
    await clickCityTool(page, "visionToggleBtn");
    await page.locator("#visionCase").selectOption("cross-left");
    await page.locator("#visionRunBtn").click();
    await page.waitForFunction(() => window.sim.world.visionLab?.firstVisualBrakeS !== null
      && window.sim.world.visionLab?.firstVisualBrakeS !== undefined,
    undefined, { timeout: 20000 });
    await clickCityTool(page, "cameraScreenToggleBtn");
    await page.waitForFunction(() => {
      const a = document.querySelector("#cameraRawCanvas"), b = document.querySelector("#cameraAnalysisCanvas");
      return a.dataset.streamId && a.dataset.streamId === b.dataset.streamId
        && a.dataset.frameId === b.dataset.frameId && Number(a.dataset.frameId) > 0
        && window.sim.vision.status.result?.detections.some((item) => item.label === "person");
    });
    const painted = await page.waitForFunction(() => {
      const raw = document.querySelector("#cameraRawCanvas"), analysis = document.querySelector("#cameraAnalysisCanvas");
      const result = window.sim.cameraResult(raw.dataset.streamId, Number(raw.dataset.frameId));
      if (!result || result.frameId !== Number(analysis.dataset.frameId)
          || result.streamId !== analysis.dataset.streamId
          || raw.dataset.frameId !== analysis.dataset.frameId
          || !document.querySelector("#cameraMotionList").textContent.includes("constant-velocity estimate; not intent"))
        return false;
      const original = raw.getContext("2d").getImageData(0, 0, 640, 360).data;
      const drawn = analysis.getContext("2d").getImageData(0, 0, 640, 360).data;
      let amber = 0;
      for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
        if (result.detections.some(({ box: [left, top, right, bottom] }) =>
          (x >= left - 4 && x <= right + 4 && y >= top - 4 && y <= bottom + 4)
          || (x >= left - 4 && x <= left + 210 && y >= top - 26 && y <= top + 2))) continue;
        const i = (y * 640 + x) * 4;
        if (Math.abs(drawn[i] - 244) <= 3 && Math.abs(drawn[i + 1] - 195) <= 3
            && Math.abs(drawn[i + 2] - 141) <= 3
            && Math.abs(drawn[i] - original[i]) + Math.abs(drawn[i + 1] - original[i + 1])
              + Math.abs(drawn[i + 2] - original[i + 2]) > 12) amber++;
      }
      const frame = window.sim.cameraFrame(raw.dataset.streamId, Number(raw.dataset.frameId));
      return amber >= 10 && frame ? {
        frame, actual: original, annotated: drawn, amberPixels: amber,
        rawPng: raw.toDataURL("image/png"), analysisPng: analysis.toDataURL("image/png"),
        width: raw.width, height: raw.height,
        status: document.querySelector("#cameraScreenStatus").textContent,
        motionText: document.querySelector("#cameraMotionList").textContent,
      } : false;
    }, undefined, { timeout: 15000, polling: 100 });
    report.camera.pixels = await painted.evaluate(async (sample) => {
      const { frame, actual, annotated } = sample;
      const bytes = Uint8Array.from(atob(frame.imageJpegBase64), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const reference = document.createElement("canvas");
      reference.width = 640; reference.height = 360;
      reference.getContext("2d").drawImage(image, 0, 0);
      image.close();
      const expected = reference.getContext("2d").getImageData(0, 0, 640, 360).data;
      let totalError = 0, changedPixels = 0;
      for (let i = 0; i < expected.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) totalError += Math.abs(expected[i + channel] - actual[i + channel]);
        if (Math.abs(actual[i] - annotated[i]) + Math.abs(actual[i + 1] - annotated[i + 1])
          + Math.abs(actual[i + 2] - annotated[i + 2]) > 12) changedPixels++;
      }
      return { streamId: frame.streamId, frameId: frame.frameId, width: sample.width, height: sample.height,
        meanRawChannelError: totalError / (640 * 360 * 3), annotatedPixels: changedPixels,
        forecastAmberPixelsOutsideBoxes: sample.amberPixels,
        camera: frame.camera, ego: frame.ego, status: sample.status,
        observedAndFittedText: sample.motionText };
    });
    const capturedPixels = await painted.evaluate((sample) => ({
      raw: sample.rawPng, analysis: sample.analysisPng, jpeg: sample.frame.imageJpegBase64,
    }));
    await writeFile(path.join(output, "camera-raw-frame.png"),
      Buffer.from(capturedPixels.raw.split(",")[1], "base64"));
    await writeFile(path.join(output, "camera-analysis-frame.png"),
      Buffer.from(capturedPixels.analysis.split(",")[1], "base64"));
    await writeFile(path.join(output, "camera-model-input.jpg"), Buffer.from(capturedPixels.jpeg, "base64"));
    report.camera.pixels.captureClass = "Direct actual product canvas pixel export at its native640x360, same atomic completed frame; not upscaled or reconstructed";
    await painted.dispose();
    assert.equal(report.camera.pixels.width, 640);
    assert.equal(report.camera.pixels.height, 360);
    assert.ok(report.camera.pixels.meanRawChannelError <= 0.5, "Raw pane must show the exact source JPEG");
    assert.ok(report.camera.pixels.annotatedPixels > 20, "Interpretation must actually draw its real observed evidence");
    report.camera.exactFrameVerified = true;
    report.camera.actualFittedForecastPaintVerified = true;
    await shot("camera-live-understanding.png");
    await page.locator("#cameraAnalysisCanvas").screenshot({ path: path.join(output, "camera-analysis-detail.png") });
    await page.setViewportSize({ width: 900, height: 650 });
    await shot("camera-compact.png");
    const cameraBounds = await page.locator("#cameraScreen").boundingBox();
    assert.ok(cameraBounds.x >= 0 && cameraBounds.x + cameraBounds.width <= 900);
    await page.locator("#cameraScreen details summary").click();
    await page.locator("#cameraMotionList").scrollIntoViewIfNeeded();
    await shot("camera-compact-evidence.png");
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.locator("#cameraScreenCloseBtn").click();
    await clickCityTool(page, "peopleToggleBtn");
    assert.equal(await page.locator("#peopleMotionMode").isDisabled(), true,
      "A body diagnostic cannot overwrite the fixed physical Vision case");
    await page.locator("#peopleCloseBtn").click();
    await clickCityTool(page, "visionToggleBtn");
    await page.locator("#visionReturnBtn").click();
    await page.bringToFront();
    await page.waitForFunction(() => window.sim.vision.status.result?.streamId === window.sim.vision.streamId
      && window.sim.vision.status.result.frameId >= 2, undefined, { timeout: 15000 });
    await clickCityTool(page, "cameraScreenToggleBtn");
    await page.locator("#cameraRawCanvas").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("#cameraAnalysisCanvas").dataset.frameId);
    await page.waitForTimeout(300);
    report.runtime = await page.evaluate(async () => {
      const first = window.sim.renderDiagnostics(), firstTick = window.sim.world.tick, start = performance.now();
      const firstModelFrame = window.sim.vision.status.result?.frameId, gaps = [];
      let previous = start, frames = first.renderedFrames, freshFrames = 0, hiddenFreshFrames = 0;
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(), draw = window.sim.renderDiagnostics();
        if (draw.renderedFrames !== frames) {
          gaps.push(now - previous);
          previous = now; frames = draw.renderedFrames;
          if (window.sim.vision.status.status === "ready") {
            freshFrames++;
            const raw = document.querySelector("#cameraRawCanvas");
            const analysis = document.querySelector("#cameraAnalysisCanvas");
            if (raw.hidden || analysis.hidden || !raw.dataset.frameId || !analysis.dataset.frameId)
              hiddenFreshFrames++;
          }
          if (draw.renderCalls <= 0 || draw.triangles <= 0) throw new Error("Blank/idle render cannot qualify");
        }
      }
      gaps.sort((a, b) => a - b);
      const elapsedS = (performance.now() - start) / 1000, last = window.sim.renderDiagnostics();
      const fps = (last.renderedFrames - first.renderedFrames) / elapsedS;
      const ticks = (window.sim.world.tick - firstTick) / elapsedS;
      const p95 = gaps[Math.floor(gaps.length * 0.95)];
      const result = window.sim.vision.status.result, config = window.sim.world.config;
      return { elapsedS, renderedFps: fps, ticksPerWallSecond: ticks, p95FrameIntervalMs: p95,
        width: last.width, height: last.height, dpr: last.pixelRatio,
        traffic: config.traffic, pedestrians: config.pedestrians,
        firstModelFrame, lastModelFrame: result?.frameId, model: result?.model,
        freshRenderedFrames: freshFrames, hiddenFreshFrames,
        visibility: document.visibilityState,
        passed: fps >= 25 && ticks >= 45 && p95 <= 100 && last.width === 1365 && last.height === 900
          && last.pixelRatio === 1 && config.traffic === (config.cityVersion === 3 ? 36 : 28)
          && config.pedestrians === (config.cityVersion === 3 ? 48 : 32)
          && result?.frameId > firstModelFrame && freshFrames > 0 && hiddenFreshFrames === 0 };
    });
    assert.ok(report.runtime.passed, JSON.stringify(report.runtime));
    await page.locator("#cameraPerceptionStopBtn").click();
    await page.waitForFunction(() => window.sim.vision.status.status === "disabled");
    report.camera.publicStopVerified = true;
    await shot("camera-stopped-unanalysed.png");
    await page.locator("#cameraScreenCloseBtn").click();
    assert.deepEqual(report.unexpectedErrors, []);
    await save("camera-people-journey.json", report);
    await save("temporal.json", temporal);
    console.log(JSON.stringify({ camera: report.camera.exactFrameVerified,
      people: report.people.publicMotionVerified, replay: report.people.replayVerified, runtime: report.runtime }));
  }
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) {
    report.current = await page.evaluate(() => ({
      environment: window.sim?.world?.environment, tick: window.sim?.world?.tick,
      vision: window.sim?.vision?.status, people: window.sim?.people,
      bodyText: document.body.innerText.slice(-10000),
    }));
    temporal.push(...await page.evaluate(() => window.__peopleMotion ?? []));
    await shot("failed.png");
  }
  await save("failure.json", report);
  await save("temporal.json", temporal);
  throw error;
} finally {
  await browser.close();
}
