import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url } = process.env;
assert.ok(output && url, "Run this check through scripts/verify_gta_browser.py");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1,
  ...(process.env.METRO_RECORD_VIDEO === "1" ? { recordVideo: { dir: join(output, "video"), size: { width: 1365, height: 900 } } } : {}) });
page.setDefaultTimeout(30_000);
const errors = [], report = {};
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
const shot = name => page.screenshot({ path: join(output, name) });

async function resetCityForJourney() {
  await clickCityTool(page, "settingsBtn");
  await page.evaluate(() => { window.__lastPursuitWorld = window.sim.world; });
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(() => window.sim.world !== window.__lastPursuitWorld);
  if (await page.locator("#closeSettings").isVisible()) await page.locator("#closeSettings").click();
  if (!await page.locator("#pursuitStyle").isVisible()) await clickCityTool(page, "streetPursuitBtn");
}

async function measurePursuit() {
  await page.bringToFront();
  return page.evaluate(() => new Promise(resolve => {
  const { world } = window.sim;
  const now = performance.now(), initialTick = world.tick;
  const initialFrame = window.sim.renderDiagnostics().renderedFrames;
  const gaps = [];
  let last = now;
  function collect() {
    const time = performance.now();
    gaps.push(time - last);
    last = time;
    if (time - now < 5000) return requestAnimationFrame(collect);
    gaps.sort((a, b) => a - b);
    const wallS = (time - now) / 1000;
    const canvas = document.querySelector("canvas.scene"), gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    resolve({
      wallS, renderedFPS: (window.sim.renderDiagnostics().renderedFrames - initialFrame) / wallS,
      tickHz: (world.tick - initialTick) / wallS,
      frameMs: { p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)] },
      civilianVehicles: world.actors.filter(a => a.type === "vehicle" && !a.pursuitRole && a !== world.player).length,
      pedestrians: world.actors.filter(a => a.type === "pedestrian").length,
      activePatrols: world.pursuit.patrols.size, distanceM: world.pursuit.metrics.distanceM,
      phase: world.pursuit.phase, adapter: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      viewport: [innerWidth, innerHeight], devicePixelRatio,
      visibility: document.visibilityState, focused: document.hasFocus(),
    });
  }
  requestAnimationFrame(collect);
  }));
}

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
  await clickCityTool(page, "streetPursuitBtn");
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

  await page.locator("#pursuitStyle").selectOption("dispatch");
  assert.equal(await page.locator("#pursuitTitle").textContent(), "Metro Dispatch");
  await page.locator("#pursuitLevel").selectOption("1");
  await shot("dispatch-selector.png");
  const beforeDispatch = await page.evaluate(() => window.sim.world.player.distance);
  await page.keyboard.down("w");
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(before => {
    const { world } = window.sim;
    return world.player.distance - before > 2 && world.pursuit?.gta?.scan?.tick > world.pursuit.startedTick;
  }, beforeDispatch);
  await page.keyboard.up("w");
  if (process.env.METRO_DENSITY_CHECK === "1") report.defaultDensity = await measurePursuit();
  assert.equal(await page.locator("#pursuitPhase").textContent(), "Zone tracked");
  await page.locator("#pursuitPanel summary").click();
  await page.locator("#pursuitZones").filter({ hasText: /civic/i }).waitFor();
  assert.doesNotMatch(await page.locator("#pursuitPatrols").textContent(), /undefined/);
  await shot("dispatch-active.png");
  await page.locator("#pauseBtn").click();
  assert.equal(await page.locator("#pauseBtn").textContent(), "Resume");
  const heldTick = await page.evaluate(() => window.sim.world.tick);
  await page.waitForFunction(() => document.getElementById("pursuitPhase")?.textContent === "Paused");
  assert.equal(await page.evaluate(() => window.sim.world.tick), heldTick);
  const dispatchRun = await page.evaluate(before => {
    const { world, view } = window.sim;
    const run = world.pursuit, initial = window.__gtaBrowser;
    return { state: run.response.dispatch.state, distanceM: world.player.distance - before,
      ruleset: run.gta.config.ruleset, scanTick: run.gta.scan.tick, mode: world.mode,
      sameWorld: world === initial.world && view.scene === initial.scene && world.player === initial.player,
      allOriginals: initial.actors.every(actor => world.actors.includes(actor)) };
  }, beforeDispatch);
  assert.equal(dispatchRun.mode, "manual");
  assert.equal(dispatchRun.ruleset, "dispatch-v1");
  assert.ok(dispatchRun.sameWorld && dispatchRun.allOriginals && dispatchRun.distanceM > 2);
  await page.locator("#pauseBtn").click();
  await page.waitForFunction(tick => window.sim.world.tick > tick, heldTick);
  await page.locator("#pauseBtn").click();
  await page.evaluate(() => {
    const { world } = window.sim;
    const { patrols, closures } = world.pursuit;
    window.__dispatchBeforeStop = {
      world, actors: world.actors.filter(actor => !patrols.has(actor)),
      statics: world.statics.filter(body => !closures.has(body)),
    };
  });
  await page.locator("#pursuitRestartBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "stopped");
  const dispatchCleaned = await page.evaluate(() => {
    const { world } = window.sim, before = window.__dispatchBeforeStop;
    return world === before.world && world.pursuit.patrols.size === 0 && world.pursuit.closures.size === 0 &&
      world.statics.length === before.statics.length && world.statics.every((body, i) => body === before.statics[i]) &&
      world.actors.length === before.actors.length && world.actors.every((actor, i) => actor === before.actors[i]);
  });
  assert.equal(dispatchCleaned, true);
  await shot("dispatch-ended.png");
  report.dispatch = { ...dispatchRun, cleanupPreserved: dispatchCleaned };

  if (process.env.METRO_PPO_CHECKPOINT) {
    await resetCityForJourney();
    const file = process.env.METRO_PPO_CHECKPOINT;
    const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    await page.locator("#pursuitStyle").selectOption("dispatch-ppo");
    assert.ok(await page.locator("#pursuitRunBtn").isDisabled());
    await page.locator("#pursuitCheckpoint").setInputFiles({
      name: "incompatible.json", mimeType: "application/json", buffer: Buffer.from('{"schema":999}'),
    });
    await page.getByText(/^Checkpoint rejected:/).waitFor();
    assert.ok(await page.locator("#pursuitRunBtn").isDisabled());
    await page.locator("#pursuitCheckpoint").setInputFiles(file);
    await page.getByText(new RegExp(`SHA-256 ${sha256.slice(0, 12)}`)).waitFor();
    await shot("ppo-ready.png");
    const startingSpeed = await page.evaluate(() => {
      window.__ppoStartWorld = window.sim.world;
      return window.sim.world.player.speed;
    });
    assert.equal(startingSpeed, 0, "PPO movement check must not count inherited coasting");
    await page.locator("#pursuitRunBtn").click();
    await page.locator("#pursuitLearning").getByText(/Frozen PPO/).waitFor();
    await page.waitForFunction(() => window.sim.world.pursuit?.frozenDriver?.decisions >= 12);
    report.ppo = await page.evaluate(() => {
      const { world } = window.sim;
      const run = world.pursuit, driver = run.frozenDriver;
      const actions = world.events.filter(e => e.tick >= run.startedTick && e.command.type === "pursuit-drive");
      return { sha256: driver.sha256, decisions: driver.decisions, distanceM: run.metrics.distanceM,
        inferenceMs: driver.inferenceMs, lastAction: actions.at(-1)?.command.action, applied: run.appliedCommand,
        phase: run.phase, sameWorld: world === window.__ppoStartWorld };
    });
    assert.equal(report.ppo.sha256, sha256);
    assert.ok(report.ppo.sameWorld && report.ppo.distanceM > 0.02);
    assert.ok(report.ppo.lastAction && Math.abs(report.ppo.applied.steer -
      .62 * report.ppo.lastAction.steer) < 1e-9);
    await shot("ppo-active.png");
    await page.keyboard.down("Space");
    await page.waitForFunction(() => {
      const { pursuit } = window.sim.world;
      return pursuit?.frozenDriver?.status === "manual" && pursuit.action?.brake === 1;
    });
    await page.keyboard.up("Space");
    const decisions = await page.evaluate(() => window.sim.world.pursuit.frozenDriver.decisions);
    await page.locator("#pursuitLearning").getByText(/Manual takeover/).waitFor();
    assert.equal(await page.evaluate(() => window.sim.world.pursuit.frozenDriver.decisions), decisions);
    report.ppo.manualTakeover = true;
    await shot("ppo-takeover.png");
    await page.locator("#pursuitRestartBtn").click();
    await page.waitForFunction(() => window.sim.world.pursuit?.phase === "stopped");
  }
  // The earlier imported-model trial can finish against a road edge. Use a
  // fresh public City start for the independent Lab-to-City movement oracle.
  await resetCityForJourney();
  await page.evaluate(() => {
    const { world, view } = window.sim;
    window.__labReturnCity = { world, scene: view.scene, actors: world.actors.slice() };
  });
  await clickCityTool(page, "labBtn");
  await page.waitForFunction(() => window.sim.world.environment === "lab");
  await clickCityTool(page, "settingsBtn");
  await page.locator("#metroPpoLab > summary").click();
  assert.ok(await page.locator("#metroPpoUse").isDisabled());
  const labStatus = page.locator("#metroPpoStatus");
  assert.match(await labStatus.textContent(), /No checkpoint/);
  for (const update of [1, 2]) {
    await page.locator("#metroPpoTrain").click();
    await page.getByText(new RegExp(`^PPO update ${update} · ${60 * update} transitions total`)).waitFor();
  }
  await shot("lab-ppo-trained.png");
  if (process.env.METRO_CROSSING_LAB_CHECK === "1") {
    await page.locator("#metroPpoStage").selectOption("left-crossing");
    await page.locator("#metroPpoTrain").click();
    await page.getByText(/^PPO update 3 · 200 transitions total/).waitFor();
    report.labCrossing = { workload: "L09", continued: true };
    await shot("lab-ppo-crossing.png");
  }
  if (process.env.METRO_ROUTE_RESUME) {
    const input = page.locator("#metroPpoResume"), workload = page.locator("#metroPpoStage");
    const file = process.env.METRO_ROUTE_RESUME;
    const startModel = JSON.parse(await readFile(file, "utf8"));
    const previousScan = await labStatus.textContent();
    const scanStage = await workload.inputValue();
    await workload.selectOption("junction-escape");
    assert.ok(await page.locator("#metroPpoUse").isDisabled());
    await input.setInputFiles({ name: "wrong-curriculum.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ ...startModel, development: { curriculumSha256: "wrong" } })) });
    await page.getByText(/^Resume rejected: Checkpoint belongs to another curriculum revision/).waitFor();
    assert.ok(await page.locator("#metroPpoUse").isDisabled());
    await input.setInputFiles(file);
    await page.getByText(new RegExp(`^Loaded PPO update ${startModel.updates}`)).waitFor();
    await page.locator("#metroPpoTrain").click();
    await page.getByText(new RegExp(`^PPO update ${startModel.updates + 1} · `)).waitFor();
    await shot("lab-route-resumed.png");
    await workload.selectOption(scanStage);
    const stillScanOnly = await labStatus.textContent();
    const scanOnlyRetained = stillScanOnly.startsWith(previousScan.split(" · last:")[0]);
    assert.equal(scanOnlyRetained, true);
    await workload.selectOption("junction-escape");
    report.routeResume = { updates: startModel.updates + 1, previousTransitions: startModel.transitions,
      previousOptimizerSteps: startModel.optimizerSteps, scanOnlyRetained };
  }
  if (process.env.METRO_CLEARANCE_RESUME) {
    assert.ok(report.routeResume && report.labCrossing, "Start with both previous checkpoint streams");
    const workload = page.locator("#metroPpoStage"), input = page.locator("#metroPpoResume");
    const file = process.env.METRO_CLEARANCE_RESUME;
    const bytes = await readFile(file);
    const startModel = JSON.parse(bytes);
    assert.equal(startModel.observation, "dispatch-route-v2");
    const oldStages = ["left-crossing", "junction-escape"], oldStatus = [];
    for (const stage of oldStages) {
      await workload.selectOption(stage);
      assert.ok(await page.locator("#metroPpoUse").isEnabled());
      oldStatus.push(await labStatus.textContent());
    }
    await workload.selectOption("city-clearance");
    assert.ok(await page.locator("#metroPpoUse").isDisabled());
    await input.setInputFiles(process.env.METRO_ROUTE_RESUME);
    await page.getByText(/^Resume rejected: Select the workload matching this checkpoint/).waitFor();
    assert.ok(await page.locator("#metroPpoUse").isDisabled());
    await input.setInputFiles(file);
    await page.getByText(new RegExp(`^Loaded PPO update ${startModel.updates} ·`)).waitFor();
    await page.locator("#metroPpoTrain").click();
    await page.getByText(new RegExp(`^PPO update ${startModel.updates + 1} ·`)).waitFor({ timeout: 55_000 });
    await shot("lab-clearance-resumed.png");
    for (const [i, stage] of oldStages.entries()) {
      await workload.selectOption(stage);
      assert.equal(await labStatus.textContent(), oldStatus[i]);
    }
    await workload.selectOption("city-clearance");
    report.clearanceResume = { updates: startModel.updates + 1, previousTransitions: startModel.transitions,
      previousOptimizerSteps: startModel.optimizerSteps, priorStreamsRetained: true,
      startSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const downloadWait = page.waitForEvent("download");
  await page.locator("#metroPpoDownload").click();
  const labCheckpoint = join(output, "lab-checkpoint.json");
  await (await downloadWait).saveAs(labCheckpoint);
  const bytes = await readFile(labCheckpoint);
  const trained = JSON.parse(bytes);
  const resumed = report.clearanceResume ?? report.routeResume;
  assert.equal(trained.updates, resumed?.updates ?? (report.labCrossing ? 3 : 2));
  if (resumed) {
    assert.equal(trained.observation, report.clearanceResume ? "dispatch-route-v2" : "dispatch-route-v1");
    assert.ok(trained.transitions > resumed.previousTransitions);
    assert.ok(trained.optimizerSteps > resumed.previousOptimizerSteps);
    resumed.transitions = trained.transitions;
    resumed.optimizerSteps = trained.optimizerSteps;
  } else assert.equal(trained.transitions, report.labCrossing ? 200 : 120);
  assert.ok(trained.optimizerSteps >= 8);
  await page.locator("#metroPpoUse").click();
  await page.getByText(/^Checkpoint selected for City/).waitFor();
  const checkpointLabel = await labStatus.textContent();
  await page.locator("#closeSettings").click();
  await clickCityTool(page, "labBtn");
  await page.waitForFunction(() => window.sim.world.environment === "metro");
  if (!await page.locator("#pursuitStyle").isVisible()) await clickCityTool(page, "streetPursuitBtn");
  assert.equal(await page.locator("#pursuitStyle").inputValue(), "dispatch-ppo");
  const cityModel = await page.locator("#pursuitCheckpointStatus").textContent();
  assert.ok(checkpointLabel.includes(cityModel) && await page.locator("#pursuitRunBtn").isEnabled());
  assert.match(cityModel, /^Lab checkpoint/);
  assert.equal(await page.locator("#pursuitCheckpoint").inputValue(), "");
  const labHash = createHash("sha256").update(bytes).digest("hex");
  assert.ok(cityModel.includes(labHash.slice(0, 12)));
  const returnedToCity = await page.evaluate(() => {
    const { world, view } = window.sim, before = window.__labReturnCity;
    return world === before.world && view.scene === before.scene &&
      before.actors.every(actor => world.actors.includes(actor));
  });
  assert.equal(returnedToCity, true);
  report.labTraining = { updates: trained.updates, transitions: trained.transitions,
    optimizerSteps: trained.optimizerSteps, returnedToCity, cityModel, sha256: labHash };
  await shot("lab-ppo-city.png");
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(requireMovement => {
    const run = window.sim.world.pursuit;
    return run?.frozenDriver?.decisions >= 8 && (!requireMovement || run.metrics.distanceM > .1);
  }, Boolean(report.clearanceResume));
  assert.equal(await page.locator("#aiToggleBtn").textContent(), "PPO · Take over");
  report.labTraining.applied = await page.evaluate(() => {
    const run = window.sim.world.pursuit;
    return { sha256: run.frozenDriver.sha256, decisions: run.frozenDriver.decisions,
      observation: run.frozenDriver.policy.observation, distanceM: run.metrics.distanceM, steer: run.appliedCommand?.steer };
  });
  assert.equal(report.labTraining.applied.sha256, labHash);
  assert.ok(Number.isFinite(report.labTraining.applied.steer));
  assert.equal(report.labTraining.applied.observation, trained.observation);
  if (!report.routeResume || report.clearanceResume) assert.ok(report.labTraining.applied.distanceM > 0);
  await page.keyboard.press("i");
  await page.waitForFunction(() => window.sim.world.pursuit?.frozenDriver?.status === "manual");
  await page.locator("#pursuitRestartBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "stopped");
  if (process.env.METRO_DENSITY_CHECK === "1") {
    await clickCityTool(page, "settingsBtn");
    await page.locator("#stressBtn").click();
    await page.waitForFunction(() => window.sim.world.capacity.traffic === 96 &&
      window.sim.world.capacity.pedestrians === 144);
    await page.locator("#closeSettings").click();
    if (!await page.locator("#pursuitStyle").isVisible()) await clickCityTool(page, "streetPursuitBtn");
    await page.locator("#pursuitStyle").selectOption("dispatch");
    await page.locator("#pursuitLevel").selectOption("5");
    await page.keyboard.down("w");
    await page.locator("#pursuitRunBtn").click();
    await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running" &&
      window.sim.world.pursuit.metrics.distanceM > 2.2);
    // The full-throttle negative reached the live barricade and wrecked.
    // For the measured run, release the accelerator before the barricade and retain actual coasting.
    await page.keyboard.up("w");
    report.highDensity = await measurePursuit();
    assert.equal(report.highDensity.civilianVehicles, 96);
    assert.equal(report.highDensity.pedestrians, 144);
    assert.ok(report.highDensity.activePatrols > 0 && report.highDensity.distanceM > 1);
    for (const sample of [report.defaultDensity, report.highDensity]) {
      assert.equal(sample.visibility, "visible");
      assert.ok(sample.renderedFPS >= 30 && sample.tickHz >= 50, JSON.stringify(sample));
    }
    await shot("dispatch-high-density.png");
    if (await page.locator("#pursuitRestartBtn").isVisible()) await page.locator("#pursuitRestartBtn").click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#pursuitStyle").selectOption("dispatch");
  await page.locator("#pursuitLevel").selectOption("1");
  await page.locator("#pursuitRunBtn").click();
  const accelerator = page.locator("#pursuitTouchThrottle");
  await accelerator.waitFor();
  assert.ok(await page.locator("#pursuitPanel").evaluate(panel => panel.getBoundingClientRect().bottom < innerHeight * .44),
    "Compact pursuit overlay must leave the middle of the scene visible");
  const touch = await page.context().newCDPSession(page);
  const { x, y, width, height } = await accelerator.boundingBox();
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x + width / 2, y: y + height / 2 }] });
  await page.waitForFunction(() => window.sim.world.pursuit?.manualAction?.throttle === 1 &&
    window.sim.world.pursuit.metrics.distanceM > .15);
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.detach();
  await page.waitForFunction(() => window.sim.world.pursuit?.manualAction?.throttle === 0);
  await shot("dispatch-compact-touch.png");
  report.touch = { acceleratedAndReleased: true, viewport: [390, 844] };
  await page.locator("#pursuitRestartBtn").click();
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
  await browser.close();
  if (page.video()) report.video = await page.video().path();
  await writeFile(join(output, "gta-browser.json"), JSON.stringify(report, null, 2));
}
