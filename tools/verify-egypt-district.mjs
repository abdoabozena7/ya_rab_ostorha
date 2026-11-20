import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  DISTRICT_CASE_IDS, analyzeDistrictCase, analyzeDistrictBaseline,
  analyzeDistrictHiddenTwin, analyzeDistrictPolicyIsolation,
} from "./district-case-analysis.mjs";
import {
  decideDistrictVisualSpeed, mappedDistrictSpeed, composeDistrictSpeed,
} from "../src/core/visual-speed-policy.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR, base = process.env.THREEJS_URL;
const mode = process.env.DISTRICT_VERIFY_MODE;
assert.ok(output && base && mode, "Use scripts\\verify_egypt_district.py");
const developmentAll = process.env.DISTRICT_DEVELOPMENT_ALL === "1";
const developmentCases = process.env.DISTRICT_DEVELOPMENT_CASES === undefined ? null
  : process.env.DISTRICT_DEVELOPMENT_CASES.split(",").map((id) => id.trim());
assert.ok(!developmentAll || mode === "case-checkpoint",
  "DISTRICT_DEVELOPMENT_ALL is only valid for a development case-checkpoint");
assert.ok(developmentCases === null || (mode === "case-checkpoint" && !developmentAll
  && developmentCases.length > 0 && new Set(developmentCases).size === developmentCases.length
  && developmentCases.every((id) => DISTRICT_CASE_IDS.includes(id))),
"DISTRICT_DEVELOPMENT_CASES requires unique known families, development case-checkpoint and no ALL flag");
await mkdir(output, { recursive: true });
const save = (name, value) => writeFile(path.join(output, name),
  JSON.stringify(value, null, name === "temporal.json" ? 0 : 2));
const report = { passed: false, unexpectedErrors: [], completedRoutes: 0 };
const temporal = [];
const purePolicy = { decide: decideDistrictVisualSpeed, mapped: mappedDistrictSpeed, compose: composeDistrictSpeed };
const frameKey = (frame) => JSON.stringify([frame.streamId, frame.frameId]);
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
let page, latestFrame, intentionalLoss = false, capturing = null;
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.unexpectedErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !(intentionalLoss && message.text().includes("ERR_BLOCKED_BY_CLIENT")))
      report.unexpectedErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin)
      report.unexpectedErrors.push(`External runtime request: ${request.url()}`);
    if (request.method() === "POST" && request.url().endsWith("/api/vision/frame")) {
      latestFrame = request.postDataJSON();
      try {
        assert.deepEqual(Object.keys(latestFrame).sort(), [
          "schema", "streamId", "frameId", "simulationTimeS", "camera", "ego", "imageJpegBase64",
        ].sort(), "District truth must not enter the actual camera API");
      } catch (error) {
        report.unexpectedErrors.push(error.message);
        return;
      }
      if (capturing) {
        const { imageJpegBase64, ...metadata } = latestFrame;
        const bytes = Buffer.from(imageJpegBase64, "base64"), key = frameKey(metadata);
        capturing.frames.set(key, { ...metadata, key, byteLength: bytes.length,
          imageSha256: createHash("sha256").update(bytes).digest("hex") });
        capturing.recentJpegs.set(key, bytes);
        if (capturing.recentJpegs.size > 24)
          capturing.recentJpegs.delete(capturing.recentJpegs.keys().next().value);
      }
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => window.sim?.vehicleRig, undefined, { timeout: 60000 });
  const shot = (name) => page.screenshot({ path: path.join(output, name) });
  const settings = async () => {
    if (await page.locator("#settingsPanel").isHidden()) await page.locator("#settingsBtn").click();
  };
  await page.evaluate(() => {
    window.__districtOriginalCity = {
      world: window.sim.world,
      actors: [...window.sim.world.actors],
    };
    window.__districtReadState = () => {
      const w = window.sim.world, result = window.sim.vision.status.result;
      const actor = (a) => ({
        id: a.id, type: a.type, x: a.x, z: a.z, heading: a.heading, speed: a.speed,
        distance: a.distance, reason: a.reason, blockedBy: a.blockedBy ?? null,
        ...(a.type === "vehicle" ? { width: a.width, length: a.length, maxSpeed: a.maxSpeed,
          goal: structuredClone(a.parking ?? a.goal ?? a.district?.goal ?? null),
          pathPointCount: a.path.length,
          pathRevision: window.__districtRecorder?.revision(a) ?? null,
          ...(a === w.player ? { sources: structuredClone(a.districtSources ?? null) } : {}),
        } : { radius: a.radius, heightM: a.body?.heightM, maxSpeed: a.body?.jogSpeedMps }),
      });
      return { tick: w.tick, timeS: w.tick / 60, environment: w.environment, mode: w.mode,
        seed: w.config.seed, capacity: structuredClone(w.capacity),
        trips: w.metrics.completedTrips, trafficTrips: w.metrics.trafficTrips,
        blockingCycles: w.metrics.trafficBlockingCycles,
        behaviorBlockingCycles: w.districtBehavior?.metrics.blockingCycles ?? 0,
        peakBehaviorBlockingCycles: w.districtBehavior?.metrics.peakBlockingCycles ?? 0,
        player: actor(w.player),
        traffic: w.actors.filter((a) => a.type === "vehicle" && a !== w.player).map(actor),
        encounter: w.districtCase ? {
          id: w.districtCase.id, phase: w.districtCase.phase, error: w.districtCase.error ?? null,
        } : null,
        people: w.actors.filter((a) => a.type === "pedestrian").map(actor),
        resources: w.districtBehavior ? structuredClone({
          reservations: w.districtBehavior.reservations, holds: w.districtBehavior.holds,
          queues: w.districtBehavior.queues, approaches: w.districtBehavior.approaches,
        }) : null,
        visual: structuredClone(w.visualState ?? null),
        result: result ? structuredClone(result) : null,
        apiStatus: window.sim.vision.status.status,
        audit: w.audit(),
      };
    };
  });
  const state = (drain = false) => page.evaluate((drain) => {
    const current = window.__districtReadState(), recorder = window.__districtRecorder;
    if (drain && recorder) current.capture = {
      samples: recorder.samples.splice(0), observations: recorder.pendingObservations.splice(0),
      policyInputs: recorder.policyInputs.splice(0),
    };
    return current;
  }, drain);
  await page.locator("#pauseBtn").click();
  const city = await state();
  await settings();
  await page.evaluate(() => window.sim.activate("egypt"));
  await page.waitForFunction(() => window.sim.world.environment === "egypt");
  const entered = await state();
  assert.deepEqual(entered.capacity, { traffic: 28, pedestrians: 32 });
  assert.deepEqual(entered.audit, []);
  await page.locator("#closeSettings").click();
  await shot("district-entry.png");
  const startCamera = async () => {
    await page.locator("#cameraScreenToggleBtn").click();
    await page.locator("#cameraPerceptionStartBtn").click();
    await page.waitForFunction(() => window.sim.vision.status.status === "ready"
      && window.sim.vision.status.result?.streamId === window.sim.vision.streamId,
    undefined, { timeout: 30000 });
    await page.locator("#cameraScreenCloseBtn").click();
  };
  const runCase = async (id, seed, driver = "vision-first") => {
    const run = { id, seed, driver,
      evidenceClass: "live public UI, rendered RGB/local NN, read-only accepted fixed-step measurements",
      samples: [], observations: [], policyInputs: [], faults: [], frames: [], paths: [] };
    temporal.push(run);
    const capture = { run, frames: new Map(), recentJpegs: new Map(), retained: new Set() };
    capturing = capture;
    let withholdFrames = false;
    const frameRoute = id === "camera-loss-recovery" ? (route) => {
      if (!withholdFrames) return route.continue();
      const frame = route.request().postDataJSON();
      run.faults.push({ type: "request-blocked", timeS: frame.simulationTimeS,
        streamId: frame.streamId, frameId: frame.frameId });
      return route.abort("blockedbyclient");
    } : null;
    if (frameRoute) await page.route("**/api/vision/frame", frameRoute);
    await settings();
    await page.locator("#districtCase").selectOption(id);
    await page.locator("#settingsForm input[name=seed]").fill(seed);
    await page.locator("#settingsForm button[type=submit]").click();
    await page.locator("#districtMode").selectOption(driver);
    run.actualConfig = await page.evaluate(() => structuredClone(window.sim.world.config));
    assert.equal(run.actualConfig.seed, seed, "The physical world must use the recorded evaluation seed");
    assert.equal(run.actualConfig.districtCase, id, "The physical world must use the recorded case");
    run.geometry = await page.evaluate(() => {
      const world = window.sim.world, original = world.step;
      const paths = [], pathSignatures = new Map(), observations = new Map();
      const recorder = {
        world, original, samples: [], pendingObservations: [], policyInputs: [], paths,
        ticks: 0, errors: [], captureErrors: [], lastPolicyS: -Infinity, lastPolicyState: null,
        policyCount: 0, lastSample: null,
        revision(car) {
          const signature = JSON.stringify(car.path);
          const previous = pathSignatures.get(car.id);
          if (previous?.signature === signature) return previous.revision;
          if (paths.length >= 64) { recorder.captureErrors.push("path evidence limit exceeded"); return null; }
          const revision = (previous?.revision ?? -1) + 1;
          paths.push({ actorId: car.id, revision, firstTick: world.tick,
            points: car.path.map(({ x, z }) => ({ x, z })) });
          pathSignatures.set(car.id, { signature, revision });
          return revision;
        },
      };
      const encounter = world.districtCase;
      recorder.geometry = structuredClone({
        playerStart: encounter.playerStart, goal: encounter.goal,
        trafficGoals: world.actors.filter((a) => a.type === "vehicle" && a !== world.player)
          .map((a) => ({ id: a.id, goal: a.parking ?? a.goal ?? a.district?.goal })),
        roads: world.roads, statics: world.statics,
        cautionZones: world.district.cautionZones, conflictZones: world.district.conflictZones,
        occluderId: encounter.occluderId, waitingZoneId: encounter.waitingZoneId,
      });
      const retain = (sample, before) => {
        const { tick, timeS, player, traffic, people, resources, blockingCycles,
          behaviorBlockingCycles, peakBehaviorBlockingCycles, audit } = sample;
        recorder.samples.push({ tick, timeS, player, traffic, people, resources, blockingCycles,
          behaviorBlockingCycles, peakBehaviorBlockingCycles, audit,
          decisionTimeS: before ? before.tick * (1 / 60) : null,
          decisionEgo: before ? { x: before.player.x, z: before.player.z,
            headingRad: before.player.heading, speedMps: before.player.speed,
            widthM: before.player.width, lengthM: before.player.length } : null,
          visualAgeMs: sample.visual?.ageMs ?? null });
        recorder.lastSample = recorder.samples.at(-1);
        if (audit.length) recorder.errors.push({ tick, errors: audit });
      };
      recorder.wrapper = function (...args) {
        if (world.districtCase.phase !== "running") return Reflect.apply(original, this, args);
        const beforeTick = world.tick;
        const before = window.__districtReadState();
        const previousState = structuredClone(world.districtSpeedState);
        const value = Reflect.apply(original, this, args);
        if (world.tick === beforeTick) return value;
        try {
          recorder.ticks++;
          if (recorder.ticks > 5402) {
            recorder.captureErrors.push("90-second fixed-step evidence bound exceeded");
            return value;
          }
          if (recorder.ticks === 1) retain(before, null);
          const after = window.__districtReadState();
          retain(after, before);
          const visual = world.visualState;
          if (visual?.streamId != null && visual.frameId != null) {
            const key = JSON.stringify([visual.streamId, visual.frameId]);
            if (!observations.has(key)) {
              const result = window.sim.cameraResult(visual.streamId, visual.frameId);
              const item = { key, observedTick: world.tick,
                result: result ? structuredClone(result) : null, visual: structuredClone(visual) };
              if (observations.size < 1500) {
                observations.set(key, item);
                recorder.pendingObservations.push(item);
              } else recorder.captureErrors.push("frame evidence bound exceeded");
            }
          }
          const sources = after.player.sources;
          const policyState = JSON.stringify([sources?.visual?.state, sources?.visual?.reason,
            sources?.visual?.available, sources?.map?.zoneId]);
          if (sources?.visual && (before.timeS - recorder.lastPolicyS >= .5
              || policyState !== recorder.lastPolicyState)) {
            if (recorder.policyCount < 256) {
              recorder.policyInputs.push({ tick: after.tick, input: {
                visual: structuredClone(visual), ego: recorder.lastSample.decisionEgo,
                requestedSpeedMps: sources.behaviorMps, nowS: before.tick * (1 / 60),
                visionRequired: world.visualMode === "vision-first", previousState,
              }, expected: { visual: sources.visual, map: sources.map, composedMps: sources.composedMps } });
              recorder.policyCount++;
              recorder.lastPolicyS = before.timeS;
              recorder.lastPolicyState = policyState;
            } else recorder.captureErrors.push("pure-policy evidence bound exceeded");
          }
        } catch (error) {
          recorder.captureErrors.push({ tick: world.tick, message: error.message });
        }
        return value;
      };
      window.__districtRecorder = recorder;
      world.step = recorder.wrapper;
      return recorder.geometry;
    });
    await page.locator("#districtRunBtn").click();
    await page.waitForFunction(() => window.sim.world.districtCase?.phase === "running",
      undefined, { timeout: 30000 });
    const deadline = Date.now() + 70000;
    let captured = false, capturedStop = false, faultStarted = false, faultRecovered = false;
    let final, recoveryStreamId;
    const retainJpeg = async (key, reason) => {
      if (!key || capture.retained.has(reason) || capture.retained.size >= 6) return;
      const bytes = capture.recentJpegs.get(key), frame = capture.frames.get(key);
      if (!bytes || !frame) return;
      frame.jpegReasons ??= [];
      frame.jpegReasons.push(reason);
      if (frame.jpegFile) { capture.retained.add(reason); return; }
      const file = `${seed}-${id}-${driver}-${reason}.jpg`;
      await writeFile(path.join(output, file), bytes);
      frame.jpegFile = file;
      capture.retained.add(reason);
    };
    while (Date.now() < deadline) {
      const current = await state(true), batch = current.capture;
      delete current.capture;
      run.samples.push(...batch.samples);
      run.observations.push(...batch.observations);
      run.policyInputs.push(...batch.policyInputs);
      final = current;
      assert.deepEqual(current.audit, []);
      for (const observation of batch.observations) {
        await retainJpeg(observation.key, "first-frame");
        if (observation.result?.detections.some((item) => item.label === "person"))
          await retainJpeg(observation.key, "seen-person");
        if (faultRecovered && observation.result?.streamId === recoveryStreamId) {
          if (!capture.retained.has("recovery-first"))
            await retainJpeg(observation.key, "recovery-first");
          else {
            const first = [...capture.frames.values()].find((frame) => frame.jpegReasons?.includes("recovery-first"));
            if (first?.key !== observation.key) await retainJpeg(observation.key, "recovery-second");
          }
        }
      }
      const source = current.player.sources?.visual;
      if (!run.earlyCameraTimings && current.timeS >= 3.5)
        run.earlyCameraTimings = await page.evaluate(() => window.sim.vision.transport);
      const currentKey = source?.frameId != null ? frameKey(source) : null;
      if (source && ["caution", "slow", "stop"].includes(source.state))
        await retainJpeg(currentKey, "camera-response");
      if (Math.abs(current.player.speed) <= 1e-8 && source?.state === "stop")
        await retainJpeg(currentKey, "physical-zero");
      if (id === "camera-loss-recovery" && current.tick >= 60
          && current.player.speed > .05 && !faultStarted) {
        intentionalLoss = true;
        withholdFrames = true;
        const measured = await state();
        run.faults.push({ type: "withhold-start", tick: measured.tick,
          timeS: measured.timeS, speedMps: measured.player.speed });
        faultStarted = true;
      }
      if (faultStarted && !faultRecovered
          && current.player.sources?.visual?.state === "unavailable"
          && Math.abs(current.player.speed) <= 1e-8
          && current.visual?.ageMs > 750) {
        const previousStream = await page.evaluate(() => window.sim.vision.streamId);
        await page.locator("#cameraScreenToggleBtn").click();
        await page.locator("#cameraPerceptionStartBtn").click();
        await page.waitForFunction((old) => window.sim.vision.streamId !== old, previousStream);
        const retry = await state();
        const newStreamId = await page.evaluate(() => window.sim.vision.streamId);
        recoveryStreamId = newStreamId;
        run.faults.push({ type: "public-retry", tick: retry.tick, timeS: retry.timeS,
          oldStreamId: previousStream, newStreamId });
        withholdFrames = false;
        const resumed = await state();
        run.faults.push({ type: "withhold-end", tick: resumed.tick, timeS: resumed.timeS,
          speedMps: resumed.player.speed });
        intentionalLoss = false;
        await page.waitForFunction(() => window.sim.vision.status.status === "ready",
          undefined, { timeout: 30000 });
        await page.locator("#cameraScreenCloseBtn").click();
        faultRecovered = true;
      }
      if (!captured && ["camera-pixels", "static-map", "both", "physical-guard"]
        .includes(current.player.sources?.appliedSource)) {
        await shot(`${seed}-${id}-${driver}-interaction.png`);
        captured = true;
      }
      if (!capturedStop && Math.abs(current.player.speed) <= 1e-8
          && current.player.sources?.visual?.state === "stop"
          && ["camera-pixels", "both"].includes(current.player.sources?.appliedSource)) {
        await shot(`${seed}-${id}-${driver}-actual-visual-stop.png`);
        capturedStop = true;
      }
      if (current.encounter.phase === "complete" || current.encounter.error) break;
      await page.waitForTimeout(100);
    }
    const retained = await page.evaluate(() => {
      const recorder = window.__districtRecorder;
      if (recorder.world.step === recorder.wrapper) recorder.world.step = recorder.original;
      const result = { geometry: recorder.geometry, paths: recorder.paths,
        samples: recorder.samples, observations: recorder.pendingObservations,
        policyInputs: recorder.policyInputs, ticks: recorder.ticks,
        errors: recorder.errors, captureErrors: recorder.captureErrors,
        cameraTimings: window.sim.vision.transport };
      delete window.__districtRecorder;
      return result;
    });
    run.samples.push(...retained.samples);
    run.observations.push(...retained.observations);
    run.policyInputs.push(...retained.policyInputs);
    run.geometry = retained.geometry;
    run.paths = retained.paths;
    run.cameraTimings = retained.cameraTimings;
    assert.ok(Array.isArray(run.cameraTimings), "Retain the actual client capture/transport stage timings");
    if (frameRoute) await page.unroute("**/api/vision/frame", frameRoute);
    run.frames = [...capture.frames.values()];
    run.jpegArtifacts = [];
    for (const frame of run.frames.filter((item) => item.jpegFile)) {
      const bytes = await readFile(path.join(output, frame.jpegFile));
      const imageSha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(imageSha256, frame.imageSha256, "The retained JPEG must be the actual posted source");
      run.jpegArtifacts.push({ file: frame.jpegFile, imageSha256, byteLength: bytes.length, key: frame.key });
    }
    run.completed = final?.encounter.phase === "complete";
    run.captureErrors = retained.captureErrors;
    run.analysis = analyzeDistrictCase(run);
    run.policyIsolation = analyzeDistrictPolicyIsolation(run, purePolicy);
    capturing = null;
    assert.ok(retained.ticks > 0 && retained.errors.length === 0
      && retained.captureErrors.length === 0, JSON.stringify(retained.errors.concat(retained.captureErrors)));
    assert.ok(run.completed, `${seed}/${id}/${driver}: ${final?.encounter.error ?? "did not complete"}`);
    assert.ok(run.analysis.passed, `${seed}/${id}/${driver}: ${JSON.stringify(run.analysis.violations)}`);
    assert.ok(run.policyIsolation.passed, `${seed}/${id}/${driver}: strict captured-input policy replay failed: ${
      JSON.stringify(run.policyIsolation.checks.filter((check) => !check.passed))}`);
    assert.ok(run.jpegArtifacts.length > 0, "Retain at least one actual source JPEG, not only hashes or screenshots");
    const metrics = run.analysis.metrics;
    return { id, seed, driver, ...metrics, completed: run.completed,
      analysis: run.analysis, policyIsolation: run.policyIsolation,
      everyTickAudit: { ticks: retained.ticks, errors: retained.errors, captureErrors: retained.captureErrors },
      faultStarted, faultRecovered, finalPlayer: final.player };
  };

  if (mode === "checkpoint") {
    await startCamera();
    await page.waitForTimeout(1000);
    await shot("district-live-checkpoint.png");
    const observed = await page.evaluate(async () => {
      const start = performance.now(), before = window.sim.renderDiagnostics(), w = window.sim.world;
      const firstTick = w.tick, firstNnFrame = window.sim.vision.status.result.frameId;
      const positions = w.actors.map(({ id, x, z }) => ({ id, x, z }));
      const gaps = [];
      let last = start, rendered = before.renderedFrames;
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(), draw = window.sim.renderDiagnostics();
        if (draw.renderedFrames !== rendered) {
          gaps.push(now - last); last = now; rendered = draw.renderedFrames;
          if (draw.renderCalls <= 0 || draw.triangles <= 0) throw new Error("Blank render cannot qualify");
        }
      }
      gaps.sort((a, b) => a - b);
      const seconds = (performance.now() - start) / 1000, after = window.sim.renderDiagnostics();
      const result = window.sim.vision.status.result;
      const gl = document.querySelector("canvas.scene").getContext("webgl2");
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return { developmentOnly: true, elapsedS: seconds,
        renderedFps: (after.renderedFrames - before.renderedFrames) / seconds,
        ticksPerWallSecond: (w.tick - firstTick) / seconds,
        p95FrameMs: gaps[Math.floor(gaps.length * .95)], capacity: w.capacity,
        firstNnFrame, lastNnFrame: result?.frameId, model: result?.model,
        width: after.width, height: after.height, dpr: after.pixelRatio,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "not exposed",
        actuallyMoved: w.actors.filter((actor, index) => Math.hypot(
          actor.x - positions[index].x, actor.z - positions[index].z) > .1).length,
        failedAssets: window.sim.view.status.failed, audit: w.audit(),
        props: window.sim.view.districtProps?.diagnostics };
    });
    await save("checkpoint.json", observed);
    assert.ok(observed.renderedFps >= 25 && observed.ticksPerWallSecond >= 45
      && observed.p95FrameMs <= 100 && observed.lastNnFrame > observed.firstNnFrame, JSON.stringify(observed));
    assert.ok(observed.actuallyMoved > 0);
    assert.deepEqual(observed.audit, []);
    assert.deepEqual(report.unexpectedErrors, []);
    console.log(JSON.stringify(observed));
  } else if (mode === "cases" || mode === "case-checkpoint") {
    const development = mode === "case-checkpoint";
    const fullMatrix = !development || developmentAll || developmentCases !== null;
    report.developmentOnly = development;
    report.caseOutcomes = 0;
    report.prelaneVisualStops = 0;
    report.predictiveFalseStops = 0;
    report.cases = [];
    const allIds = await page.locator("#districtCase option").evaluateAll((options) =>
      options.map((option) => option.value).filter((value) => value !== "ambient"));
    assert.deepEqual([...allIds].sort(), [...DISTRICT_CASE_IDS].sort(),
      "All twelve specific predeclared families, not twelve arbitrary completion labels");
    const ids = developmentCases ?? (fullMatrix ? allIds : ["visible-left", "visible-right"]);
    report.coverage = { selectedFamilies: ids, partialDevelopmentMatrix: development && ids.length < allIds.length,
      fullAcceptance: !development };
    for (const seed of development ? ["district-dev-a"] : ["district-cairo-a", "district-cairo-b", "district-cairo-c"]) {
      for (const id of ids) {
        const result = await runCase(id, seed);
        if (["visible-left", "visible-right"].includes(id)) {
          assert.ok(result.seenFrames >= 3 && result.stopBeforeEntry,
            `${seed}/${id}: need a complete actual visual stop before later physical lane entry`);
          report.prelaneVisualStops++;
        }
        if (["stationary-curb", "parallel-away"].includes(id))
          assert.ok(result.seenFrames >= 3, `${id}: an unseen negative person cannot pass`);
        if (["stationary-curb", "parallel-away", "same-occluder-empty", "blind-corner-empty"].includes(id)) {
          assert.equal(result.predictiveStops, 0, `${id}: false predictive stop`);
          report.predictiveFalseStops += result.predictiveStops;
        }
        report.cases.push(result);
        report.caseOutcomes++;
      }
      for (const id of ["visible-left", "visible-right"].filter((id) => ids.includes(id))) {
        const baseline = await runCase(id, seed, "sensors-only");
        const predictive = report.cases.find((item) => item.seed === seed && item.id === id);
        const predictiveTrace = temporal.find((run) => run.id === id && run.seed === seed && run.driver === "vision-first");
        const baselineTrace = temporal.find((run) => run.id === id && run.seed === seed && run.driver === "sensors-only");
        const comparison = analyzeDistrictBaseline(predictiveTrace, baselineTrace);
        assert.ok(comparison.passed, `Same-map independent-safety causal control: ${JSON.stringify(comparison)}`);
        report.cases.push({ ...baseline, comparison, predictiveStopS: predictive.firstStopS });
      }
      for (const id of fullMatrix
        ? ["stationary-curb", "parallel-away", "same-occluder-empty"].filter((id) => ids.includes(id)) : []) {
        const baseline = await runCase(id, seed, "sensors-only");
        const predictive = report.cases.find((item) => item.seed === seed && item.id === id);
        const predictiveTrace = temporal.find((run) => run.id === id && run.seed === seed && run.driver === "vision-first");
        const baselineTrace = temporal.find((run) => run.id === id && run.seed === seed && run.driver === "sensors-only");
        const comparison = analyzeDistrictBaseline(predictiveTrace, baselineTrace);
        assert.ok(comparison.passed, `${seed}/${id}: actual same-map noncrossing control: ${JSON.stringify(comparison)}`);
        report.cases.push({ ...baseline, predictiveApproachSpeedMps: predictive.approachMinimumSpeedMps, comparison });
      }
      if (fullMatrix && ids.includes("fully-hidden-emergence") && ids.includes("same-occluder-empty")) {
        const hidden = temporal.find((run) => run.seed === seed && run.id === "fully-hidden-emergence"
          && run.driver === "vision-first");
        const empty = temporal.find((run) => run.seed === seed && run.id === "same-occluder-empty"
          && run.driver === "vision-first");
        const comparison = analyzeDistrictHiddenTwin(hidden, empty, { policyIsolation: hidden.policyIsolation });
        report.hiddenTwinChecks ??= [];
        report.hiddenTwinChecks.push({ seed, ...comparison });
        assert.ok(comparison.passed, `${seed}: actual hidden/empty and strict identical-input isolation: ${JSON.stringify(comparison)}`);
      }
      await page.locator("#cameraScreenToggleBtn").click();
      await page.locator("#cameraPerceptionStopBtn").click();
      await page.locator("#cameraScreenCloseBtn").click();
    }
    assert.ok(report.caseOutcomes >= (development ? ids.length : 36)
      && report.prelaneVisualStops >= (development
        ? ids.filter((id) => ["visible-left", "visible-right"].includes(id)).length : 6));
    assert.deepEqual(report.unexpectedErrors, []);
    report.passed = true;
    await save(development ? "case-checkpoint.json" : "district-cases.json", report);
  } else if (mode === "negative") {
    await startCamera();
    const invalid = await page.request.post(base + "api/vision/frame", {
      data: { ...latestFrame, frameId: latestFrame.frameId + 1000, actors: [{ x: 0, z: 0, intent: "cross" }] },
    });
    assert.equal(invalid.status(), 400);
    await page.locator("#phoneToggleBtn").click();
    await page.locator("#phonePlaces button").first().click();
    await page.locator("#phoneToggleBtn").click();
    await page.waitForFunction(() => window.sim.world.player.speed > .5, undefined, { timeout: 15000 });
    const speedBeforeLoss = (await state()).player.speed;
    intentionalLoss = true;
    await page.route("**/api/vision/frame", (route) => route.abort("blockedbyclient"));
    await page.waitForFunction(() => window.sim.world.visualState?.ageMs > 750,
      undefined, { timeout: 15000 });
    await page.waitForFunction(() => window.sim.world.player.districtSources?.visual?.state === "unavailable"
      && Math.abs(window.sim.world.player.speed) < .05, undefined, { timeout: 10000 });
    const failed = await state();
    await shot("district-unavailable.png");
    await page.locator("#cameraScreenToggleBtn").click();
    await page.locator("#cameraPerceptionStartBtn").click();
    await page.unroute("**/api/vision/frame");
    intentionalLoss = false;
    await page.waitForFunction(() => window.sim.vision.status.status === "ready",
      undefined, { timeout: 30000 });
    await page.locator("#cameraScreenCloseBtn").click();
    await settings();
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#replayBtn").click();
    const download = await downloadEvent;
    const replayFile = path.join(output, "unsupported-district-replay.json");
    const replayPath = path.join(output, "actual-district-replay.json");
    await download.saveAs(replayPath);
    const replay = JSON.parse(await readFile(replayPath, "utf8"));
    replay.config.districtVersion = 999;
    await writeFile(replayFile, JSON.stringify(replay));
    await page.locator("#replayFile").setInputFiles(replayFile);
    await page.waitForFunction(() => document.querySelector("#replayProgress").textContent
      .includes("Unsupported Egyptian district layout version"));
    const replayError = await page.locator("#replayProgress").textContent();
    assert.equal((await state()).environment, "egypt");
    const result = { detected: true, forbiddenTruthRejected: invalid.status(), speedBeforeLoss,
      failed, unsupportedReplayRejected: replayError,
      recoveryFresh: true, unexpectedErrors: report.unexpectedErrors };
    assert.deepEqual(report.unexpectedErrors, []);
    await save("negative.json", result);
    console.log("EXPECTED_DISTRICT_FAILURE_DETECTED");
    process.exitCode = 3;
  } else {
    await startCamera();
    await page.locator("canvas").first().click({ position: { x: 650, y: 450 } });
    const throttleAt = Date.now();
    await page.keyboard.down("KeyW");
    await page.waitForFunction(() => window.sim.world.player.speed > .05);
    const throttleResponseMs = Date.now() - throttleAt;
    await page.waitForFunction(() => window.sim.world.player.speed >= 1);
    const speedBeforeBrake = (await state()).player.speed;
    assert.ok(speedBeforeBrake >= 1, "The brake response must start from actual sustained movement");
    const brakeAt = Date.now();
    await page.keyboard.down("Space");
    await page.waitForFunction((speed) => window.sim.world.player.speed < speed - .01, speedBeforeBrake);
    const brakeResponseMs = Date.now() - brakeAt;
    await page.keyboard.up("KeyW");
    await page.keyboard.up("Space");
    assert.ok(throttleResponseMs <= 300 && brakeResponseMs <= 300,
      JSON.stringify({ throttleResponseMs, brakeResponseMs }));
    report.drivingControls = { throttleResponseMs, brakeResponseMs, speedBeforeBrake };
    report.routes = [];
    const names = await page.evaluate(() => window.sim.world.district.places.map((place) => place.name));
    for (const name of names) {
      const before = await state();
      await page.locator("#phoneToggleBtn").click();
      await page.locator("#phonePlaces").getByRole("button", { name, exact: true }).click();
      await page.locator("#phoneToggleBtn").click();
      const samples = [], deadline = Date.now() + 150000;
      temporal.push({ route: name, samples });
      while (Date.now() < deadline) {
        const current = await state();
        samples.push(current);
        assert.deepEqual(current.audit, []);
        if (current.trips > before.trips) break;
        await page.waitForTimeout(200);
      }
      const final = samples.at(-1);
      report.routes.push({ name, final, completed: final.trips === before.trips + 1 });
      assert.equal(final.trips, before.trips + 1, `Destination ${name} was not actually reached`);
      assert.ok(Math.abs(final.player.speed) <= .05);
      report.completedRoutes++;
      await shot(`district-arrival-${report.completedRoutes}.png`);
    }
    await page.locator("#cameraScreenToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#cameraAnalysisCanvas").dataset.frameId);
    await shot("district-camera-sources.png");
    await page.setViewportSize({ width: 900, height: 650 });
    await shot("district-camera-compact.png");
    await page.locator("#cameraScreenCloseBtn").click();
    await settings();
    await shot("district-settings-compact.png");
    await page.locator("#closeSettings").click();
    await page.locator("#peopleToggleBtn").click();
    await shot("district-people-compact.png");
    await page.locator("#peopleCloseBtn").click();
    await page.setViewportSize({ width: 1365, height: 900 });
    report.runtime = await page.evaluate(async () => {
      const start = performance.now(), before = window.sim.renderDiagnostics(), firstTick = window.sim.world.tick;
      const firstNnFrame = window.sim.vision.status.result.frameId, gaps = [];
      let previous = start, rendered = before.renderedFrames;
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(), draw = window.sim.renderDiagnostics();
        if (draw.renderedFrames !== rendered) {
          if (draw.renderCalls <= 0 || draw.triangles <= 0) throw new Error("Blank render cannot pass");
          gaps.push(now - previous); previous = now; rendered = draw.renderedFrames;
        }
      }
      gaps.sort((a, b) => a - b);
      const seconds = (performance.now() - start) / 1000, after = window.sim.renderDiagnostics();
      const fps = (after.renderedFrames - before.renderedFrames) / seconds;
      const ticks = (window.sim.world.tick - firstTick) / seconds;
      const p95 = gaps[Math.floor(gaps.length * .95)], capacity = window.sim.world.capacity;
      return { elapsedS: seconds, renderedFps: fps, ticksPerWallSecond: ticks, p95FrameMs: p95,
        width: after.width, height: after.height, dpr: after.pixelRatio, capacity,
        firstNnFrame, lastNnFrame: window.sim.vision.status.result?.frameId,
        passed: fps >= 25 && ticks >= 45 && p95 <= 100 && after.width === 1365
          && after.height === 900 && after.pixelRatio === 1 && capacity.traffic === 28
          && capacity.pedestrians === 32 && window.sim.vision.status.result?.frameId > firstNnFrame };
    });
    assert.ok(report.runtime.passed, JSON.stringify(report.runtime));
    await page.locator("#pauseBtn").click();
    const physicalBeforeReplay = await page.evaluate(() => {
      const w = window.sim.world, snapshot = w.snapshot();
      return { tick: w.tick, actors: snapshot.actors, metrics: snapshot.metrics, rng: snapshot.rng };
    });
    await settings();
    const replayDownload = page.waitForEvent("download");
    await page.locator("#replayBtn").click();
    const replay = await replayDownload;
    await replay.saveAs(path.join(output, "public-district-replay.json"));
    const data = JSON.parse(await readFile(path.join(output, "public-district-replay.json"), "utf8"));
    assert.equal(data.environment, "egypt");
    assert.equal(data.config.districtVersion, 1);
    await page.locator("#replayFile").setInputFiles(path.join(output, "public-district-replay.json"));
    await page.waitForFunction(() => document.querySelector("#replayProgress").textContent
      .includes("Replay restored"), undefined, { timeout: 90000 });
    const physicalAfterReplay = await page.evaluate(() => {
      const w = window.sim.world, snapshot = w.snapshot();
      return { tick: w.tick, actors: snapshot.actors, metrics: snapshot.metrics, rng: snapshot.rng };
    });
    assert.deepEqual(physicalAfterReplay, physicalBeforeReplay,
      "Actual public replay import must reconstruct the district's accepted physics and behavior");
    report.replayVerified = true;
    await page.locator("#districtReturnBtn").click();
    const restored = await state();
    const sameCityObjects = await page.evaluate(() => {
      const saved = window.__districtOriginalCity, world = window.sim.world;
      return world === saved.world && world.actors.length === saved.actors.length
        && world.actors.every((actor, index) => actor === saved.actors[index]);
    });
    report.cityPreserved = sameCityObjects && restored.seed === city.seed && restored.tick >= city.tick
      && restored.tick <= city.tick + 30 && restored.environment === city.environment;
    assert.ok(report.cityPreserved, JSON.stringify({ city, restored, sameCityObjects }));
    await page.locator("#closeSettings").click();
    await shot("district-returned-city.png");
    assert.deepEqual(report.unexpectedErrors, []);
    report.passed = true;
    await save("district-journey.json", report);
  }
  await save("temporal.json", temporal);
} catch (error) {
  report.failure = error.stack;
  if (capturing) {
    const run = capturing.run;
    run.frames = [...capturing.frames.values()];
    run.failure = error.message;
    try {
      const partial = await page.evaluate(() => {
        const recorder = window.__districtRecorder;
        if (!recorder) return null;
        if (recorder.world.step === recorder.wrapper) recorder.world.step = recorder.original;
        return { samples: recorder.samples.splice(0),
          observations: recorder.pendingObservations.splice(0),
          policyInputs: recorder.policyInputs.splice(0), paths: recorder.paths,
          geometry: recorder.geometry, captureErrors: recorder.captureErrors, auditErrors: recorder.errors };
      });
      if (partial) {
        run.samples.push(...partial.samples);
        run.observations.push(...partial.observations);
        run.policyInputs.push(...partial.policyInputs);
        Object.assign(run, { paths: partial.paths, geometry: partial.geometry,
          captureErrors: partial.captureErrors, auditErrors: partial.auditErrors });
      }
      run.analysis = analyzeDistrictCase(run);
    } catch (captureError) { run.captureFailure = captureError.message; }
  }
  if (page && !page.isClosed()) {
    report.current = await page.evaluate(() => {
      const world = window.sim?.world;
      return {
        environment: world?.environment, tick: world?.tick, paused: window.sim?.paused,
        text: document.body.innerText.slice(-12000),
        snapshot: world?.snapshot(),
        actorData: world ? structuredClone(world.actors) : null,
        replay: world?.replay(),
        vehiclePlans: world?.actors.filter((actor) => actor.type === "vehicle").map((actor) => ({
          id: actor.id, path: structuredClone(actor.path), cursor: actor.cursor,
          parking: structuredClone(actor.parking ?? null), district: structuredClone(actor.district ?? null),
          spec: structuredClone(actor.spec ?? null), wait: actor.wait,
        })),
        transport: window.sim?.vision.transport,
      };
    });
    if (report.current.replay) {
      await save("failed-public-replay.json", report.current.replay);
      delete report.current.replay;
      report.current.replayFile = "failed-public-replay.json";
    }
    await page.screenshot({ path: path.join(output, "failed.png") });
  }
  await save("failure.json", report);
  await save("temporal.json", temporal);
  throw error;
} finally {
  await browser.close();
}
