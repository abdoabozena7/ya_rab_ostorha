import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/pako-rl-curb-chase-20261122/headed-browser");
mkdirSync(outDir, { recursive: true });

function resolvePlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "playwright",
    "C:\\Users\\A-plus\\AppData\\Roaming\\Python\\Python313\\site-packages\\playwright\\driver\\package",
  ].filter(Boolean);
  for (const mod of candidates) {
    try {
      return require(mod);
    } catch {
      // try next installed path
    }
  }
  throw new Error("Could not resolve installed Playwright driver package.");
}

async function freeLoopbackPort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(err => err ? rej(err) : res(port));
    });
    srv.on("error", rej);
  });
}

async function waitForServer(url, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Owned server exited early with code ${proc.exitCode}`);
    try {
      const resp = await fetch(`${url}/api/health`);
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("Owned loopback server timed out waiting for /api/health");
}

const { chromium } = resolvePlaywright();
assert.ok(existsSync(chromium.executablePath()), "Chromium binary must exist locally");

const port = await freeLoopbackPort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverProc = spawn("python", ["-S", "-m", "backend.threejs.server", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: rootDir,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serverLogs = "";
serverProc.stdout.on("data", chunk => { serverLogs += chunk.toString(); });
serverProc.stderr.on("data", chunk => { serverLogs += chunk.toString(); });

let browser = null;
const report = { passed: false, errors: [], ownedServerPid: serverProc.pid };

try {
  await waitForServer(baseUrl, serverProc);
  browser = await chromium.launch({
    headless: false,
    args: ["--force-device-scale-factor=1"],
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(16000);
  const attachErrors = targetPage => {
    targetPage.on("pageerror", err => report.errors.push(err.message));
    targetPage.on("response", resp => {
      if (resp.status() >= 400 && !resp.url().endsWith("/favicon.ico"))
        report.errors.push(`${resp.status()} ${resp.url()}`);
    });
  };
  attachErrors(page);
  const id = name => page.locator(`#${name}`);
  const wait = (fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });

  await page.goto(baseUrl);
  await wait(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);

  // 1. Open Chase -> verify RL AI is active by default (NOT stuck on "You drive")!
  await id("pakoBtn").click();
  assert.equal(await id("pursuitTitle").textContent(), "Chase");
  const readyScene = await id("pursuitScene").textContent();
  assert.match(readyScene, /RL PPO/i);
  assert.equal(await id("pakoDriverRl").getAttribute("aria-pressed"), "true");

  // Select Level 5 Max and start RL chase!
  await id("pursuitLevel").selectOption("5");
  await page.screenshot({ path: join(outDir, "chase-ready-rl.png") });
  await page.evaluate(() => {
    window.__chaseWorld = window.sim.world;
    window.__chaseActors = [...window.sim.world.actors];
  });
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running" &&
    window.sim.world.pursuit?.frozenDriver?.decisions >= 18 &&
    Math.abs(window.sim.world.player.speed) > 1.5);

  report.defaultRlMax = await page.evaluate(() => {
    const { world } = window.sim, { pursuit: run, player } = world;
    const patrols = [...run.patrols].filter(u => u.aiState !== "WRECKED");
    const dists = patrols.map(u => Math.hypot(u.x - player.x, u.z - player.z)).sort((a, b) => a - b);
    return {
      phase: run.phase,
      tick: world.tick,
      wantedLevel: run.wantedLevel,
      driver: run.frozenDriver?.status ?? "manual",
      decisions: run.frozenDriver?.decisions ?? 0,
      identity: run.frozenDriver?.sha256 ?? null,
      speedKmh: Math.round(Math.abs(player.speed) * 3.6),
      distanceM: run.metrics.distanceM,
      patrolCount: patrols.length,
      nearestPatrolM: dists[0] ?? Infinity,
      within48M: dists.filter(d => d <= 48).length,
      curbMode: run.gta.config.curbSupport ?? null,
      chasePresence: run.gta.config.chasePresence ?? null,
      pedestrianCollisions: run.metrics.pedestrianCollisions,
      sameWorld: window.__chaseWorld === world,
      sameActors: window.__chaseActors.every(a => world.actors.includes(a)),
      learningBanner: document.getElementById("pursuitLearning")?.textContent ?? "",
      unitBanner: document.getElementById("pursuitUnitCount")?.textContent ?? "",
      patrols: patrols.map(u => ({
        id: u.id,
        unitType: u.unitType,
        aiState: u.aiState,
        speedMps: +u.speed.toFixed(2),
        rangeM: +Math.hypot(u.x - player.x, u.z - player.z).toFixed(2),
      })),
    };
  });

  assert.equal(report.defaultRlMax.driver, "active");
  assert.equal(report.defaultRlMax.wantedLevel, 5);
  assert.equal(report.defaultRlMax.curbMode, "metro-city-curbs-v2");
  assert.equal(report.defaultRlMax.chasePresence, "city-chase-v1");
  assert.ok(report.defaultRlMax.nearestPatrolM <= 36, `Expected close police <= 36 m, got ${report.defaultRlMax.nearestPatrolM}`);
  assert.ok(report.defaultRlMax.within48M >= 2, "Expected multiple visible police units within 48 m scanner range");
  assert.equal(report.defaultRlMax.pedestrianCollisions, 0);
  assert.ok(report.defaultRlMax.sameWorld && report.defaultRlMax.sameActors);

  // Let the Max RL chase run further to capture active evasion & police closing in frame,
  // and sustain past 27s (or episode completion) to prove zero permanent 0 km/h stall and zero back-and-forth oscillation.
  await page.evaluate(() => {
    window.__maxRunningWaitS = 0;
    window.__oscillated = false;
    window.__prevGear = 1;
    window.__gearFlips = 0;
    window.__samples = [];
    window.__stepCounter = 0;
    const origStep = window.sim.world.step.bind(window.sim.world);
    window.sim.world.step = function (...args) {
      const res = origStep(...args);
      if (this.pursuit?.phase === "running") {
        window.__maxRunningWaitS = Math.max(window.__maxRunningWaitS, this.player.wait ?? 0);
        const g = this.pursuit.frozenDriver?.lastDecision?.submitted?.gear ?? 1;
        if (g !== window.__prevGear) {
          window.__gearFlips++;
          window.__prevGear = g;
        }
        if (++window.__stepCounter % 30 === 0) {
          window.__samples.push({
            x: this.player.x,
            z: this.player.z,
            dist: this.pursuit.metrics.distanceM,
            flips: window.__gearFlips,
          });
          if (window.__samples.length > 13) {
            const old = window.__samples[window.__samples.length - 13];
            const cur = window.__samples[window.__samples.length - 1];
            if (cur.flips - old.flips >= 4 && cur.dist - old.dist >= 2.2 && Math.hypot(cur.x - old.x, cur.z - old.z) < 3.2) {
              window.__oscillated = true;
            }
          }
        }
      }
      return res;
    };
  });
  await wait(() => window.sim.world.pursuit?.metrics.distanceM >= 20 ||
    window.sim.world.tick >= 420 ||
    window.sim.world.pursuit?.phase !== "running", null, 30000);
  await page.screenshot({ path: join(outDir, "max-rl-chase.png") });

  const measureSustainedChase = () => page.evaluate(() => {
    const { world } = window.sim, { pursuit: run, player } = world;
    const maxRunningWaitS = Number((window.__maxRunningWaitS ?? 0).toFixed(2));
    return {
      phase: run.phase,
      survivalS: Number(run.metrics.survivalS.toFixed(1)),
      distanceM: Number(run.metrics.distanceM.toFixed(1)),
      shoulderEntries: run.metrics.shoulderEntries,
      collisions: run.metrics.collisions,
      pedestrianCollisions: run.metrics.pedestrianCollisions,
      maxRunningWaitS,
      endChaseDisabled: document.getElementById("pursuitRestartBtn")?.disabled ?? false,
      oscillated: Boolean(window.__oscillated),
      stalled: (run.phase === "running" && (player.wait ?? 0) > 6.5) || maxRunningWaitS > 6.5,
      playerPose: { x: +player.x.toFixed(2), z: +player.z.toFixed(2), speed: +player.speed.toFixed(2), curbId: player.curbSupportId ?? null },
    };
  });

  await wait(() => (window.sim.world.pursuit?.metrics.survivalS ?? 0) >= 27 ||
    window.sim.world.pursuit?.phase !== "running", null, 45000);
  report.sustainedMaxChase = await measureSustainedChase();
  assert.equal(report.sustainedMaxChase.stalled, false, `Sustained Max chase stalled: ${JSON.stringify(report.sustainedMaxChase)}`);
  assert.equal(report.sustainedMaxChase.oscillated, false, `Sustained Max chase oscillated: ${JSON.stringify(report.sustainedMaxChase)}`);
  assert.equal(report.sustainedMaxChase.pedestrianCollisions, 0);

  // If an unseeded opening cross-street interceptor caught the SUV in an early clean busted (<20 s),
  // exercise "Run again" (#pursuitRunBtn) to also verify a full sustained multi-block chase (>60 m).
  if (report.sustainedMaxChase.distanceM <= 60 && report.sustainedMaxChase.phase !== "running") {
    report.firstAttemptCleanBusted = report.sustainedMaxChase;
    await page.evaluate(() => {
      window.__maxRunningWaitS = 0;
      window.__oscillated = false;
      window.__gearFlips = 0;
      window.__samples = [];
    });
    await id("pursuitRunBtn").click();
    await wait(() => window.sim.world.pursuit?.phase === "running" && window.sim.world.pursuit?.frozenDriver?.decisions >= 6);
    await wait(() => (window.sim.world.pursuit?.metrics.survivalS ?? 0) >= 27 ||
      window.sim.world.pursuit?.phase !== "running", null, 45000);
    report.sustainedMaxChase = await measureSustainedChase();
  }
  report.maxChaseAfter = report.sustainedMaxChase;
  assert.equal(report.sustainedMaxChase.stalled, false, `Sustained Max chase stalled: ${JSON.stringify(report.sustainedMaxChase)}`);
  assert.equal(report.sustainedMaxChase.oscillated, false, `Sustained Max chase oscillated: ${JSON.stringify(report.sustainedMaxChase)}`);
  assert.equal(report.sustainedMaxChase.pedestrianCollisions, 0);
  assert.ok(report.sustainedMaxChase.distanceM > 60, `Expected sustained chase distance > 60 m, got ${report.sustainedMaxChase.distanceM}`);
  await page.screenshot({ path: join(outDir, "sustained-max-chase.png") });
  if (await page.evaluate(() => window.sim.world.pursuit?.phase === "running")) {
    assert.equal(report.sustainedMaxChase.endChaseDisabled, false);
    await id("pursuitRestartBtn").click();
    await wait(() => window.sim.world.pursuit.phase === "stopped");
  }
  const postChaseAudit = await page.evaluate(() => window.sim.world.audit().filter(x => x.includes("player")));
  assert.deepEqual(postChaseAudit, [], `Expected clean player audit after curb chase end, got ${JSON.stringify(postChaseAudit)}`);
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running");
  await id("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "stopped");

  // 2. Verify optional Manual toggle works cleanly too, then switch back to RL AI
  await id("pakoDriverManual").click();
  assert.equal(await id("pakoDriverManual").getAttribute("aria-pressed"), "true");
  await id("pakoDriverRl").click();
  assert.equal(await id("pakoDriverRl").getAttribute("aria-pressed"), "true");

  // 3. Verify Car's view: 360 range + real YOLOX camera + pedestrian forecast ghosts
  await page.evaluate(() => {
    const sim = window.sim;
    sim.reset({ seed: "metro-camera-causal-a", traffic: 0, pedestrians: 1, chaos: 0, speedLimit: 25, cityVersion: 4 });
    const { world } = sim, { player: ego } = world, person = world.actors.find(a => a.type === "pedestrian");
    const road = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
    const crossingX = ego.x + 8.5, sideZ = ego.z + 2.1;
    const target = { x: crossingX, z: ego.z - 4 };
    Object.assign(person, {
      kind: "man-polo", x: crossingX, z: sideZ, target, road,
      heading: Math.PI, crossing: true, speed: 0, walkSpeed: 1.35, pause: 0, walkRoute: [target],
      walkGoal: `${target.x},${target.z}`, walkPlanTick: 0, motionMode: "stop",
      district: { ...person.district, caseId: "city-focus-local-crossing", stage: "moving",
        routeConstrained: true, holdAtTarget: true, yieldAtCurb: false, origin: { x: crossingX, z: sideZ } },
    });
    person.previous = { ...person };
    world.updateSensors();
    window.__measuredPerson = person;
  });
  if (!await id("driveSense").isVisible()) await id("driveSenseBtn").click();
  await wait(() => window.sim.cityPerception?.rangeTick !== null &&
    Boolean(document.getElementById("driveSenseImage").dataset.frameId));
  await id("driveSenseDetector").click();
  await wait(() => {
    const state = window.sim.cityPerception;
    const canvas = document.getElementById("driveSenseImage");
    return state?.camera === "matched" && state.people > 0 && Number(canvas.dataset.frameId) === state.cameraFrame;
  }, null, 38000);
  await page.evaluate(() => { window.__measuredPerson.motionMode = "ambient"; });
  await wait(() => window.sim.cityPerception?.forecasts.some(row => row.source === "camera" && row.points.length > 1));
  await page.screenshot({ path: join(outDir, "pedestrian-forecast.png") });
  report.sensing = await page.evaluate(() => ({
    camera: window.sim.cityPerception.camera,
    people: window.sim.cityPerception.people,
    forecastsCount: window.sim.cityPerception.forecasts.length,
    ghostsAreNotActors: !window.sim.world.actors.some(a => /forecast/.test(a.id)),
  }));
  assert.ok(report.sensing.forecastsCount > 0 && report.sensing.ghostsAreNotActors);
  await id("driveSenseDetector").click();
  await wait(() => window.sim.cityPerception?.camera === "off");
  await id("driveSenseClose").click();

  // 4. Verify Train & test in Lab -> real PPO training update -> Use in Chase!
  await page.goto(baseUrl);
  await wait(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("1");
  await id("pako-training").click();
  await id("pakoLabSetup").locator("summary").click();
  await id("metroPpoStage").selectOption("chase-level-1");
  await id("pakoEpisodeLimit").fill("1");
  await id("pakoLabSetup").locator("summary").click();
  await id("pakoTrain").click();
  await wait(() => ["completed", "fault"].includes(window.sim.pursuitTraining?.status), null, 95000);
  report.training = await page.evaluate(() => {
    const s = window.sim.pursuitTraining;
    return {
      status: s.status,
      error: s.error ?? null,
      episodes: s.episodes,
      updates: s.updates,
      transitions: s.transitions,
      optimizerSteps: s.optimizerSteps,
      lastPhase: s.lastEpisode?.phase,
      lastDistanceM: s.lastEpisode?.distanceM,
      pedestrianImpacts: s.lastEpisode?.pedestrianImpacts,
    };
  });
  assert.equal(report.training.status, "completed", report.training.error ?? "Lab training failed");
  assert.ok(report.training.updates >= 1 && report.training.transitions >= 100);
  assert.equal(report.training.pedestrianImpacts, 0);
  await id("pakoWatchLast").click();
  await wait(() => window.sim.ghostReplay?.count === 1 && window.sim.ghostReplay.tick > 12);
  await page.screenshot({ path: join(outDir, "lab-training-replay.png") });
  await id("metroPpoUse").click();
  await wait(() => window.sim.world.environment === "metro");
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running" && window.sim.world.pursuit?.frozenDriver?.decisions >= 4);
  report.labModelInChase = await page.evaluate(() => ({
    driver: window.sim.world.pursuit.frozenDriver?.status,
    decisions: window.sim.world.pursuit.frozenDriver?.decisions,
    identity: window.sim.world.pursuit.frozenDriver?.sha256,
  }));
  assert.equal(report.labModelInChase.driver, "active");
  await page.close();

  // 5. Mobile 390x844 geometry check (no panel overlap with Car's view)
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  attachErrors(mobile);
  await mobile.goto(baseUrl);
  await mobile.waitForFunction(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);
  await mobile.locator("#pakoBtn").tap();
  await mobile.locator("#driveSenseBtn").tap();
  await mobile.waitForFunction(() => window.sim.cityPerception?.rangeTick > 0 &&
    Boolean(document.getElementById("driveSenseImage").dataset.frameId));
  report.mobile = await mobile.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chaseBottom: document.getElementById("pursuitPanel").getBoundingClientRect().bottom,
    perceptionTop: document.getElementById("driveSense").getBoundingClientRect().top,
  }));
  assert.ok(report.mobile.scrollWidth <= report.mobile.innerWidth &&
    report.mobile.chaseBottom + 8 <= report.mobile.perceptionTop, JSON.stringify(report.mobile));
  await mobile.screenshot({ path: join(outDir, "compact-chase.png") });
  await mobile.close();

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (err) {
  report.errors.push(err?.stack || err?.message || String(err));
} finally {
  if (browser) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5000)),
    ]);
  }
  if (serverProc.exitCode === null) {
    serverProc.kill();
    await Promise.race([
      new Promise(r => serverProc.once("exit", r)),
      new Promise(r => setTimeout(r, 3000)),
    ]);
  }
  report.serverStopped = serverProc.exitCode !== null || serverProc.killed;
  writeFileSync(join(outDir, "city-focus-browser.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, "server.log"), serverLogs);
}

assert.ok(report.passed, `Headed browser verification failed: ${JSON.stringify(report.errors)}`);
console.log(JSON.stringify({ passed: report.passed, defaultRlMax: report.defaultRlMax, training: report.training, mobile: report.mobile }));
process.exit(0);
