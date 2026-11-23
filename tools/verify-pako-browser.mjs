import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const url = process.env.THREEJS_URL;
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(16000);
const id = value => page.locator(`#${value}`);
const shot = file => page.screenshot({ path: join(output, file) });
const errors = [];
const report = { controls: [], errors };
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

async function city() {
  await page.goto(url);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
}

async function driving(style = "ordinary") {
  await city();
  if (style === "ordinary") return;
  await clickCityTool(page, "streetPursuitBtn");
  await id("pursuitStyle").selectOption(style);
  await id("pursuitLevel").selectOption("1");
  await id("pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running");
  if (style === "survival") await page.keyboard.press("i");
  await page.waitForFunction(() => window.sim.world.mode === "manual");
}

async function sample() {
  return page.evaluate(() => {
    const { world } = window.sim, { x, z, heading, speed } = world.player;
    return { tick: world.tick, x, z, heading, speed, phase: world.pursuit?.phase,
      camera: window.sim.renderDiagnostics().cameraMode };
  });
}

async function surveyedCurbSetting() {
  await city();
  await clickCityTool(page, "streetPursuitBtn");
  await id("pursuitStyle").selectOption("dispatch");
  await id("pursuitLevel").selectOption("1");
  const toggle = id("pursuitCurbSupport");
  assert.ok(await toggle.isVisible() && !await toggle.isChecked());
  await toggle.check();
  await shot("curb-pilot-option.png");
  await page.evaluate(() => {
    window.curbBrowserStartedFrom = { world: window.sim.world, actors: [...window.sim.world.actors] };
  });
  await id("pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running");
  const active = await page.evaluate(() => {
    const world = window.sim.world;
    return {
      survey: world.pursuit.gta.config.curbSupport, mode: world.mode,
      sameCity: world === window.curbBrowserStartedFrom.world,
      retainedActors: window.curbBrowserStartedFrom.actors.every(actor => world.actors.includes(actor)),
      recorded: world.replay().events.filter(event => event.command.type === "street-pursuit-start").at(-1)?.command.config.curbSupport,
    };
  });
  assert.deepEqual(active, { survey: "metro-survey-v1", mode: "manual", sameCity: true, retainedActors: true,
    recorded: "metro-survey-v1" });
  await id("pursuitRestartBtn").click();
  await toggle.uncheck();
  await id("pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running");
  assert.equal(await page.evaluate(() => window.sim.world.pursuit.gta.config.curbSupport ?? null), null);
  return active;
}

async function compareForecasts(path) {
  await id("pakoForecastComparison").locator(":scope > summary").click();
  const file = id("pakoForecastFile"), canvas = id("pakoForecastMap"), result = id("pakoForecastResult");
  await file.setInputFiles({ name: "invalid-forecast.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await page.waitForFunction(() => document.getElementById("pakoForecastStatus").textContent.includes("Could not load"));
  assert.ok(!await result.isVisible());
  await file.setInputFiles(path);
  await canvas.waitFor();
  const label = await canvas.getAttribute("aria-label");
  assert.match(label, /matched times.*Dashed forecast, solid measured trajectory/);
  const image = await canvas.evaluate(element => element.toDataURL());
  await id("pakoForecastBranch").selectOption({ index: 2 });
  assert.notEqual(await canvas.evaluate(element => element.toDataURL()), image);
  const alternate = await canvas.getAttribute("aria-label");
  assert.notEqual(alternate, label);
  await canvas.scrollIntoViewIfNeeded();
  await shot("candidate-forecast-comparison.png");
  await id("pakoForecastComparison").locator(":scope > summary").click();
  return { label, alternate, invalidRejected: true };
}

async function verifyCityReplay(paths, tick) {
  const episode = paths.episodes[0], pose = episode.trajectory.find(point => point[0] === tick);
  assert.ok(pose, "The step control must use a persisted physical sample");
  const drawMode = id("pakoGhostCamera");
  await page.evaluate(() => { window.beforeReplayWorld = window.sim.world; });
  await drawMode.selectOption("city");
  await page.waitForFunction(() => window.sim.ghostReplay?.count === 1);
  const observed = await page.evaluate(() => ({
    ...window.sim.ghostReplay, sameModelWorld: window.beforeReplayWorld === window.sim.world,
    layerHasNoColliders: !window.sim.world.actors.some(actor => actor.id.includes("pako-recorded-ghost")),
  }));
  assert.ok(observed.sameModelWorld && observed.layerHasNoColliders);
  assert.equal(observed.selected[0].id, episode.id);
  assert.equal(observed.tick, tick);
  assert.ok(Math.abs(observed.selected[0].x - pose[1]) < 1e-9 && Math.abs(observed.selected[0].z - pose[2]) < 1e-9);
  await shot("city-perspective-ghost.png");
  await drawMode.selectOption("map");
  await page.waitForFunction(() => !window.sim.ghostReplay);
  return observed;
}

async function verifyBatchedSession() {
  await city();
  await id("pakoBtn").click();
  await id("pako-training").click();
  await id("pakoLabSetup").locator("summary").click();
  await id("metroPpoStage").selectOption("crossing-pursuit");
  await id("pakoWorldCount").selectOption("2");
  await id("pakoEpisodeLimit").fill("4");
  await id("pakoTrain").click();
  await page.waitForFunction(() => window.sim.pursuitTraining?.activeEpisodes?.length === 2);
  const overlap = await page.evaluate(() => window.sim.pursuitTraining.activeEpisodes.slice());
  assert.notEqual(overlap[0].id, overlap[1].id);
  assert.notEqual(overlap[0].seed, overlap[1].seed);
  assert.equal(overlap[0].policy.updates, overlap[1].policy.updates);
  const activity = await id("pakoSessionStatus").textContent();
  assert.match(activity, /2\/2 simulation worlds.*One worker/);
  await shot("batched-worlds.png");
  await page.waitForFunction(() => ["completed", "fault"].includes(window.sim.pursuitTraining?.status),
    undefined, { timeout: 50000 });
  const stopped = await page.evaluate(() => window.sim.pursuitTraining);
  assert.equal(stopped.status, "completed", stopped.error);
  assert.equal(stopped.activeWorlds, 0);
  assert.equal(stopped.episodes, 4);
  assert.equal(stopped.updates, 2);
  assert.equal(stopped.transitions, 320);
  return { overlap, activity, updates: stopped.updates, transitions: stopped.transitions, episodes: stopped.episodes };
}

async function maneuver(style, key, { reverse = false, cockpit = false, stationary = false } = {}) {
  await driving(style);
  if (cockpit) await page.keyboard.press("c");
  const start = await sample();
  const pedal = reverse ? "s" : "w";
  if (!stationary) await page.keyboard.down(pedal);
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(tick => window.sim.world.tick >= tick, start.tick + 41);
    const end = await sample();
    const dx = end.x - start.x, dz = end.z - start.z;
    // At a +Z heading, the forward-looking camera projects -X to the right.
    const lateral = -dx * Math.cos(start.heading) + dz * Math.sin(start.heading);
    const along = dx * Math.sin(start.heading) + dz * Math.cos(start.heading);
    const delta = end.heading - start.heading;
    const left = key === "a" || key === "ArrowLeft", expectedSide = Number(left) * -2 + 1;
    const result = { style, key, reverse, stationary, start, end, lateral, along, delta };
    report.controls.push(result);
    if (stationary) assert.ok(Math.abs(lateral) < .03 && Math.abs(delta) < .04, JSON.stringify(result));
    else {
      assert.ok(lateral * expectedSide * (reverse ? -1 : 1) > .025, JSON.stringify(result));
      assert.ok(delta * expectedSide * (reverse ? 1 : -1) > .03, JSON.stringify(result));
      assert.ok(along * (reverse ? -1 : 1) > .15, JSON.stringify(result));
    }
    if (cockpit) assert.equal(end.camera, "cockpit");
  } finally {
    await page.keyboard.up(key);
    if (!stationary) await page.keyboard.up(pedal);
  }
}

async function mobileSteering() {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true });
  const touch = await phone.context().newCDPSession(phone);
  try {
    await phone.goto(url);
    await phone.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
    await clickCityTool(phone, "streetPursuitBtn", "tap");
    await phone.locator("#pursuitStyle").selectOption("dispatch");
    await phone.locator("#pursuitLevel").selectOption("1");
    await phone.locator("#pursuitRunBtn").tap();
    const box = async (id, key) => {
      const r = await phone.locator(`#${id}`).boundingBox();
      assert.ok(r, `${id} not visible on compact touch profile`);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: key };
    };
    const points = await Promise.all([box("pursuitTouchLeft", 1), box("pursuitTouchThrottle", 2)]);
    const pose = () => phone.evaluate(() => {
      const { player, tick } = window.sim.world;
      return { tick, x: player.x, z: player.z, heading: player.heading, speed: player.speed };
    });
    const before = await pose();
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
    await phone.waitForFunction(tick => window.sim.world.tick >= tick, before.tick + 40);
    const after = await pose();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await phone.waitForFunction(() => window.sim.world.pursuit.manualAction.throttle === 0 &&
      window.sim.world.pursuit.manualAction.steer === 0);
    const lateral = (after.z - before.z) * Math.sin(before.heading) - (after.x - before.x) * Math.cos(before.heading);
    assert.ok(lateral < -.025 && after.heading - before.heading > .03 && after.speed > .5,
      JSON.stringify({ before, after, lateral }));
    await phone.screenshot({ path: join(output, "compact-steering.png") });
    return { before, after, lateral };
  } finally { await phone.close(); }
}

async function fleetCapacity() {
  await city();
  await id("pakoBtn").click();
  await id("pako-training").click();
  await id("pakoLabSetup").locator("summary").click();
  await id("metroPpoStage").selectOption("maneuver");
  await id("pakoEpisodeLimit").fill("100");
  await id("pakoTimeLimit").fill("150");
  await id("pakoTrainingSpeed").selectOption("fast");
  await id("pakoGhostFleet").locator(":scope > summary").click();
  const started = Date.now();
  await id("pakoTrain").click();
  await page.waitForFunction(() => ["completed", "fault"].includes(window.sim.pursuitTraining?.status),
    undefined, { timeout: 150000 });
  const { status, episodes, updates, transitions, error } = await page.evaluate(() => window.sim.pursuitTraining);
  assert.equal(status, "completed", error);
  assert.equal(episodes, 100);
  assert.equal(updates, 100);
  assert.equal(await id("pakoGhostFocus").locator("option").count(), 101);
  assert.match(await id("pakoGhostSummary").textContent(), /100 displayed \/ 100 recorded/);
  const wallS = (Date.now() - started) / 1000;
  const before = Number(await id("pakoGhostTime").inputValue());
  await id("pakoGhostPlay").click();
  await page.waitForFunction(tick => document.getElementById("pakoGhostTime").valueAsNumber < tick, before);
  const rendering = await page.evaluate(() => new Promise(resolve => {
    const first = performance.now(), counters = window.sim.renderDiagnostics();
    let previous = first;
    const deltas = [];
    function sample(now) {
      deltas.push(now - previous);
      previous = now;
      if (now - first < 2000) return requestAnimationFrame(sample);
      deltas.sort((a, b) => a - b);
      resolve({ seconds: (now - first) / 1000, browserFrameP95Ms: deltas[Math.floor(deltas.length * .95)],
        rendered: window.sim.renderDiagnostics().renderedFrames - counters.renderedFrames,
        playbackTick: document.getElementById("pakoGhostTime").valueAsNumber });
    }
    requestAnimationFrame(sample);
  }));
  await id("pakoGhostPlay").click();
  assert.ok(rendering.playbackTick >= 100 && rendering.rendered / rendering.seconds >= 30, JSON.stringify(rendering));
  await id("pakoGhostMap").scrollIntoViewIfNeeded();
  await shot("ghost-fleet-100.png");
  return { episodes, updates, transitions, wallS, rendering, note: "Buffered actual 128-point-cap trajectories; not parallel simulators" };
}

try {
  if (process.env.PAKO_STEERING_BASELINE === "1") {
    // Same directional oracle, intentionally exercised against the original bundle.
    for (const style of ["ordinary", "dispatch", "survival"]) {
      try { await maneuver(style, "a"); }
      catch (error) { (report.baselineFailures ??= []).push(error.message); }
    }
    assert.equal(report.baselineFailures?.length, 2);
    assert.deepEqual(report.controls.filter(row => row.lateral > 0).map(row => row.style), ["ordinary", "dispatch"]);
  } else if (process.env.PAKO_FLEET_CAPACITY === "1") {
    report.fleet = await fleetCapacity();
  } else if (process.env.PAKO_BATCHED === "1") {
    report.batched = await verifyBatchedSession();
  } else {
    await city();
    await id("pakoBtn").click();
    assert.equal(await id("pursuitTitle").textContent(), "Chase");
    assert.match(await id("pursuitScene").textContent(), /you drive/i);
    assert.ok(await id("pursuitRunBtn").isEnabled() && !await id("pursuitStyle").isVisible());
    await shot("chase-default.png");
    const populated = await page.evaluate(() => window.sim.world.actors.length);
    assert.ok(populated > 100);
    report.curbPilot = await surveyedCurbSetting();
    for (const args of [["ordinary", "a"], ["dispatch", "ArrowRight", { cockpit: true }],
      ["survival", "ArrowLeft"], ["dispatch", "d", { reverse: true }], ["dispatch", "a", { stationary: true }]])
      await maneuver(...args);
    await driving("dispatch");
    await page.evaluate(() => {
      const run = window.sim.world.pursuit;
      run.frozenDriver = { status: "active", sha256: "controlled-browser-fault", lastTick: -1, decisions: 0,
        policy: { observation: "dispatch-scan-v3", action() { throw new Error("Controlled browser inference error"); } } };
    });
    await page.waitForFunction(() => window.sim.world.pursuit.frozenDriver.status === "fault");
    assert.match(await id("safetyStatus").textContent(), /Controlled browser inference error/);
    await id("pauseBtn").click();
    const beforePause = await sample();
    await id("pursuitDiagnostics").locator("summary").click();
    const [exported] = await Promise.all([page.waitForEvent("download"), id("pursuitExportTrace").click()]);
    const traceFile = join(output, "city-decisions.jsonl");
    await exported.saveAs(traceFile);
    const records = (await readFile(traceFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.some(row => row.stopReason === "CONTROLLER_FAULT" && row.appliedAction?.brake === 1));
    assert.equal(records.at(-1).stopReason, "USER_PAUSE");
    assert.equal((await sample()).tick, beforePause.tick);
    await shot("city-fault-trace.png");
    report.trace = { rows: records.length, stopReason: records.at(-1).stopReason, pausedTick: beforePause.tick };
    await id("pursuitRestartBtn").click();
    await page.waitForFunction(() => window.sim.world.pursuit.phase === "stopped");
    const layout = await page.evaluate(() => ({
      diagnosticsOpen: document.getElementById("pursuitDiagnostics").open,
      panelBottom: document.getElementById("pursuitPanel").getBoundingClientRect().bottom,
      minimapTop: document.getElementById("minimap").getBoundingClientRect().top,
    }));
    assert.ok(layout.diagnosticsOpen && layout.panelBottom + 8 <= layout.minimapTop, JSON.stringify(layout));
    report.stoppedLayout = layout;
    await shot("city-stopped-layout.png");
    await clickCityTool(page, "settingsBtn");
    await id("cityDriver").selectOption("sensors-only");
    await id("closeSettings").click();
    await page.evaluate(() => { window.beforeSelfDriving = window.sim.world; });
    await id("selfDrivingBtn").click();
    await page.waitForFunction(() => window.sim.world === window.beforeSelfDriving &&
      window.sim.world.pursuit.phase === "stopped" && window.sim.world.mode === "auto");
    assert.equal(await page.evaluate(() => window.sim.world.actors.length), populated);

    await city();
    await id("pakoBtn").click();
    await id("pako-training").click();
    assert.equal(await id("metroPpoStage").inputValue(), "chase-level-3");
    await id("pakoLabSetup").locator("summary").click();
    await id("metroPpoStage").selectOption("crossing-pursuit");
    await id("pakoTrainingSpeed").selectOption("normal");
    if (process.env.PAKO_FORECAST_OVERLAY) report.forecasts = await compareForecasts(process.env.PAKO_FORECAST_OVERLAY);
    await id("pakoGhostFleet").locator("summary").click();
    await id("pakoEpisodeLimit").fill("4");
    await id("pakoTrain").click();
    await page.waitForFunction(() => window.sim.pursuitTraining?.status === "running");
    await id("pakoPause").click();
    await page.waitForFunction(() => window.sim.pursuitTraining?.status === "paused");
    const paused = await page.evaluate(() => window.sim.pursuitTraining);
    assert.ok(await id("pakoEvaluate").isDisabled());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.sim.pursuitTraining.episodes), paused.episodes);
    await id("pakoPause").click();
    await page.waitForFunction(() => {
      const state = window.sim.pursuitTraining;
      return ["completed", "fault"].includes(state?.status);
    }, undefined, { timeout: 45000 });
    const trained = await page.evaluate(() => window.sim.pursuitTraining);
    assert.equal(trained.status, "completed", trained.error);
    assert.equal(trained.episodes, 4);
    assert.ok(trained.updates >= 1 && trained.transitions > 60 && trained.optimizerSteps > 0);
    assert.match(await id("pakoGhostSummary").textContent(), /4 displayed \/ 4 recorded/);
    assert.equal(await id("pakoGhostFocus").locator("option").count(), 5);
    const [download] = await Promise.all([page.waitForEvent("download"), id("metroPpoDownload").click()]);
    await download.saveAs(join(output, "trained-checkpoint.json"));
    const saved = JSON.parse(await readFile(join(output, "trained-checkpoint.json"), "utf8"));
    assert.equal(saved.updates, trained.updates);
    assert.equal(saved.transitions, trained.transitions);
    await id("pakoGhostFocus").selectOption({ index: 1 });
    await id("pakoGhostStep").click();
    const ghostTime = Number(await id("pakoGhostTime").inputValue());
    assert.ok(ghostTime > 0 && ghostTime < Number(await id("pakoGhostTime").getAttribute("max")));
    const [pathsDownload] = await Promise.all([page.waitForEvent("download"), id("pakoGhostExport").click()]);
    const pathsFile = join(output, "actual-rollouts.json");
    await pathsDownload.saveAs(pathsFile);
    const paths = JSON.parse(await readFile(pathsFile, "utf8"));
    assert.equal(paths.episodes.length, 4);
    assert.equal(new Set(paths.episodes.map(episode => episode.id)).size, 4);
    assert.ok(paths.episodes.every(episode => episode.traceSource === "actual" &&
      episode.trajectory[0][0] === 0 && episode.trajectory.at(-1)[0] === episode.ticks));
    await id("pakoGhostMap").scrollIntoViewIfNeeded();
    await shot("training-actual-rollouts.png");
    report.perspective = await verifyCityReplay(paths, ghostTime);
    report.training = { status: trained.status, episodes: trained.episodes, updates: trained.updates,
      transitions: trained.transitions, optimizerSteps: trained.optimizerSteps, ghostTime,
      final: { phase: trained.lastEpisode.phase, ticks: trained.lastEpisode.ticks } };

    await id("pakoEpisodeLimit").fill("2");
    await id("pakoTrainingSpeed").selectOption("fast");
    await id("pakoEvaluate").click();
    await page.waitForFunction(() => {
      const state = window.sim.pursuitTraining;
      return state?.mode === "evaluate" && ["completed", "fault"].includes(state.status);
    });
    const tested = await page.evaluate(() => window.sim.pursuitTraining);
    assert.equal(tested.status, "completed", tested.error);
    assert.equal(tested.episodes, 2);
    assert.equal(tested.updates, trained.updates);
    assert.equal(tested.optimizerSteps, trained.optimizerSteps);
    report.testing = { updates: tested.updates, optimizerSteps: tested.optimizerSteps, episodes: tested.episodes };

    await clickCityTool(page, "labBtn");
    if (await id("pursuitPanel").isHidden()) await id("pakoBtn").click();
    assert.equal(await page.evaluate(() => window.sim.world.actors.length), populated);
    assert.equal(await page.evaluate(() => window.sim.world.pursuit?.phase ?? null), null);
    assert.ok(await id("pursuitRunBtn").isEnabled());
    await city();
    await id("pakoBtn").click();
    await id("pako-training").click();
    await id("pakoLabSetup").locator("summary").click();
    await id("metroPpoStage").selectOption("crossing-pursuit");
    await id("metroPpoResume").setInputFiles(join(output, "trained-checkpoint.json"));
    await page.waitForFunction(() => document.getElementById("metroPpoStatus").textContent.includes("Loaded PPO update"));
    await id("pakoEpisodeLimit").fill("1");
    await id("pakoTrainingSpeed").selectOption("fast");
    await id("pakoTrain").click();
    await page.waitForFunction(() => ["completed", "fault"].includes(window.sim.pursuitTraining?.status));
    const resumed = await page.evaluate(() => window.sim.pursuitTraining);
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(resumed.updates, trained.updates + 1);
    assert.ok(resumed.transitions > trained.transitions && resumed.optimizerSteps > trained.optimizerSteps);
    report.resume = { episodes: resumed.episodes, updates: resumed.updates, optimizerSteps: resumed.optimizerSteps };
    report.touch = await mobileSteering();
  }
  assert.deepEqual(errors, []);
  console.log("pako-browser-journey");
} finally {
  await writeFile(join(output, "pako-browser.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
