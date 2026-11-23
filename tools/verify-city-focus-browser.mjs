import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const checkpointPath = fileURLToPath(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const checkpointSha = createHash("sha256").update(await readFile(checkpointPath)).digest("hex");
assert.equal(checkpointSha, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(14000);
const id = name => page.locator(`#${name}`);
const shot = name => page.screenshot({ path: join(output, name) });
const wait = (fn, arg, timeout = 16000) => page.waitForFunction(fn, arg, { timeout });
const report = { passed: false, errors: [] };
const attachErrors = page => {
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
};
attachErrors(page);

async function openTool(name) {
  await id("cityTools").locator("summary").click();
  await id(name).click();
}

async function footprint() {
  return page.evaluate(() => {
    const { world } = window.sim, { pursuit: run } = world;
    return { phase: run.phase, tick: world.tick, ruleset: run.gta.config.ruleset, wantedLevel: run.wantedLevel,
      cap: run.gta.config.wantedLevelMax, patrols: [...run.patrols].map(unit => ({ type: unit.unitType, maxSpeed: unit.maxSpeed })),
      sameWorld: window.__chaseWorld === world,
      sameActors: window.__chaseActors.every(actor => world.actors.includes(actor)),
      collisions: run.metrics.collisions, timeS: run.metrics.survivalS,
      driver: run.frozenDriver?.status ?? "manual", decisions: run.frozenDriver?.decisions ?? 0,
      identity: run.frozenDriver?.sha256 ?? null, qualified: run.response.dispatch.escapeEligible };
  });
}

try {
  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);
  await id("pakoBtn").click();
  assert.equal(await id("pursuitTitle").textContent(), "Chase");
  assert.match(await id("pursuitScene").textContent(), /RL PPO/i);
  assert.ok(await id("pursuitRunBtn").isEnabled() && !await id("pursuitStyle").isVisible());
  assert.ok(!await id("streetPursuitBtn").isVisible());
  assert.equal(await page.evaluate(() => document.activeElement.id), "pursuitLevel");
  await id("pakoDriverManual").click();
  assert.match(await id("pursuitScene").textContent(), /you drive/i);
  await id("pursuitLevel").selectOption("5");
  await shot("chase-level.png");
  await page.evaluate(() => {
    window.__chaseWorld = window.sim.world;
    window.__chaseActors = [...window.sim.world.actors];
  });
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running");
  report.manualMax = await footprint();
  assert.equal(report.manualMax.wantedLevel, 5);
  assert.equal(report.manualMax.cap, 5);
  assert.equal(report.manualMax.ruleset, "dispatch-v1");
  assert.equal(report.manualMax.driver, "manual");
  assert.ok(report.manualMax.patrols.length > 1 && report.manualMax.sameWorld && report.manualMax.sameActors);
  await id("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "stopped");

  // Controlled City crossing for perception accuracy, not an unmodified City driving result.
  await page.evaluate(() => {
    const sim = window.sim;
    sim.reset({ seed: "metro-camera-causal-a", traffic: 0, pedestrians: 1, chaos: 0, speedLimit: 25, cityVersion: 4 });
    const { world } = sim, { player: ego } = world, person = world.actors.find(a => a.type === "pedestrian");
    const road = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
    const crossingX = ego.x + 8.5, sideZ = ego.z + 2.1;
    const target = { x: crossingX, z: ego.z - 4 };
    Object.assign(person, { kind: "man-polo", x: crossingX, z: sideZ, target, road,
      heading: Math.PI, crossing: true, speed: 0, walkSpeed: 1.35, pause: 0, walkRoute: [target],
      walkGoal: `${target.x},${target.z}`, walkPlanTick: 0, motionMode: "stop",
      district: { ...person.district, caseId: "city-focus-local-crossing", stage: "moving",
        routeConstrained: true, holdAtTarget: true, yieldAtCurb: false, origin: { x: crossingX, z: sideZ } } });
    person.previous = { ...person };
    world.updateSensors();
    window.__measuredPerson = person;
  });
  if (!await id("driveSense").isVisible()) await id("driveSenseBtn").click();
  await wait(() => window.sim.cityPerception?.rangeTick !== null &&
    Boolean(document.getElementById("driveSenseImage").dataset.frameId));
  assert.match(await id("driveSenseRecognition").textContent(), /detector off/i);
  await id("driveSenseDetector").click();
  await wait(() => {
    const state = window.sim.cityPerception;
    const canvas = document.getElementById("driveSenseImage");
    return state?.camera === "matched" && state.people > 0 &&
      Number(canvas.dataset.frameId) === state.cameraFrame;
  }, null, 36000);
  const personStart = await page.evaluate(() => {
    const person = window.__measuredPerson;
    person.motionMode = "ambient";
    return { z: person.z, x: person.x };
  });
  await wait(() => window.sim.cityPerception?.forecasts.some(row => row.source === "camera" && row.points.length > 1));
  await shot("pedestrian-forecast.png");
  report.sensing = await page.evaluate(start => {
    const { cityPerception, world } = window.sim;
    const person = window.__measuredPerson, canvas = document.getElementById("driveSenseImage");
    return { ...cityPerception, measuredWalkM: Math.hypot(person.x - start.x, person.z - start.z),
      imageFrame: Number(canvas.dataset.frameId), imageStream: canvas.dataset.streamId,
      result: window.sim.cameraResult(canvas.dataset.streamId, Number(canvas.dataset.frameId))?.detections,
      unrelatedPhysicalActors: world.actors.length, ghostsAreNotActors: !world.actors.some(a => /forecast/.test(a.id)) };
  }, personStart);
  assert.ok(report.sensing.forecasts.length > 0 && report.sensing.measuredWalkM > .08 &&
    report.sensing.ghostsAreNotActors && report.sensing.result?.some(row => row.label === "person"), JSON.stringify(report.sensing));
  await id("driveSenseDetector").click();
  await wait(() => window.sim.cityPerception?.camera === "off");
  assert.equal(await page.evaluate(() => window.sim.cityPerception.forecasts.some(row => row.source === "camera")), false);
  await id("driveSenseClose").click();
  assert.equal(await page.evaluate(() => window.sim.cityPerception), null);

  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await openTool("settingsBtn");
  await page.locator("input[name=seed]").fill("city-route-dev-eval-00");
  await id("pauseBtn").click();
  await page.locator("#settingsForm button[type=submit]").click();
  await wait(() => window.sim.world.config.seed === "city-route-dev-eval-00");
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("3");
  await id("pakoCheckpointChoice").locator("summary").click();
  await id("pursuitCheckpoint").setInputFiles(checkpointPath);
  await wait(() => /development checkpoint/i.test(document.getElementById("pursuitScene").textContent));
  await page.evaluate(() => {
    window.__chaseWorld = window.sim.world;
    window.__chaseActors = [...window.sim.world.actors];
  });
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.frozenDriver?.decisions >= 24);
  report.frozenStart = await footprint();
  assert.ok(report.frozenStart.sameWorld && report.frozenStart.sameActors && report.frozenStart.identity === checkpointSha);
  assert.match(await id("pursuitLearning").textContent(), /PPO test/);
  await shot("playing-ppo.png");
  await id("driveSenseClose").click();
  await wait(() => ["escaped", "timeout", "busted", "wrecked"].includes(window.sim.world.pursuit?.phase), null, 132000);
  report.frozenResult = await footprint();
  assert.ok(report.frozenResult.decisions > 30 && report.frozenResult.timeS > 5);
  await wait(() => document.getElementById("pursuitRunBtn").textContent === "Run again");
  await shot("finished-chase.png");

  await id("pursuitLevel").selectOption("5");
  await id("pako-training").click();
  assert.equal(await id("metroPpoStage").inputValue(), "chase-level-5");
  assert.match(await id("pakoWorkloadNote").textContent(), /96 vehicles and 144 people/);
  assert.ok(!await id("pakoLabSetup").evaluate(details => details.open));
  await shot("full-city-training.png");
  await id("pakoLabSetup").locator("summary").click();
  await id("metroPpoStage").selectOption("chase-level-3");
  await id("pakoEpisodeLimit").fill("1");
  await id("pakoLabSetup").locator("summary").click();
  await id("pakoTrain").click();
  const finished = () => ["completed", "fault"].includes(window.sim.pursuitTraining?.status);
  await wait(finished, null, 49000);
  report.training = await page.evaluate(() => window.sim.pursuitTraining);
  assert.equal(report.training.status, "completed", report.training.error);
  assert.equal(report.training.episodes, 1);
  assert.equal(report.training.updates, 1);
  assert.equal(report.training.lastEpisode.rewardProfile, "clean-escape-v1");
  assert.ok(report.training.transitions > 100 && report.training.lastEpisode.ticks > 100);
  assert.ok(!await id("metroPpoUse").isDisabled());
  assert.match(await id("pakoEpisodeOutcomes").textContent(), /[01]\/1 clean escapes/);
  await id("pakoWatchLast").click();
  await wait(() => window.sim.ghostReplay?.count === 1 && window.sim.ghostReplay.tick > 12);
  assert.equal(await page.evaluate(() => window.sim.ghostReplay.selected[0].id), report.training.lastEpisode.id);
  await shot("training-outcome.png");
  await id("pakoEvaluate").click();
  await wait(finished, null, 49000);
  report.testing = await page.evaluate(() => window.sim.pursuitTraining);
  assert.equal(report.testing.status, "completed", report.testing.error);
  assert.equal(report.testing.episodes, 1);
  assert.equal(report.testing.lastEpisode.rewardProfile, report.training.lastEpisode.rewardProfile);
  assert.equal(report.testing.updates, report.training.updates);
  assert.equal(report.testing.optimizerSteps, report.training.optimizerSteps);
  await id("metroPpoUse").click();
  await wait(() => window.sim.world.environment === "metro" &&
    /development checkpoint/i.test(document.getElementById("pursuitScene").textContent));
  await id("pursuitLevel").selectOption("3");
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "running" && window.sim.world.pursuit.frozenDriver?.decisions > 3);
  report.restartedWithLabPolicy = await footprint();
  assert.ok(report.restartedWithLabPolicy.sameWorld && report.restartedWithLabPolicy.identity !== checkpointSha);
  await id("pursuitRestartBtn").click();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  attachErrors(mobile);
  await mobile.goto(base);
  await mobile.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
  await mobile.locator("#pakoBtn").tap();
  assert.ok(await mobile.locator("#pursuitRunBtn").isVisible() && !await mobile.locator("#pursuitStyle").isVisible());
  await mobile.locator("#driveSenseBtn").tap();
  assert.ok(await mobile.locator("#driveSenseMap").isVisible());
  await mobile.waitForFunction(() => window.sim.cityPerception?.rangeTick > 0 &&
    Boolean(document.getElementById("driveSenseImage").dataset.frameId));
  const geometry = await mobile.evaluate(() => ({
    innerWidth, scrollWidth: document.documentElement.scrollWidth,
    chaseBottom: document.getElementById("pursuitPanel").getBoundingClientRect().bottom,
    perceptionTop: document.getElementById("driveSense").getBoundingClientRect().top,
  }));
  assert.ok(geometry.scrollWidth <= geometry.innerWidth && geometry.chaseBottom + 8 <= geometry.perceptionTop, JSON.stringify(geometry));
  report.mobile = geometry;
  await mobile.screenshot({ path: join(output, "compact-chase.png") });
  await mobile.locator("#cityTools > summary").tap();
  await mobile.locator("#streetPursuitBtn").tap();
  assert.ok(await mobile.locator("#pursuitStyle").isVisible());
  await mobile.close();
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  if (!report.passed) await shot("failed-city-focus.png");
  await writeFile(join(output, "city-focus-browser.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
