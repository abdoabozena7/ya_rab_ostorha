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
  : resolve(rootDir, ".runtime-proof/tactical-police-escape-20261123/headed-browser");
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
      // try next
    }
  }
  throw new Error("Could not resolve installed Playwright driver package.");
}

async function freeLoopbackPort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(err => (err ? rej(err) : res(port)));
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
  browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000);
  page.on("pageerror", err => report.errors.push(err.message));
  page.on("response", resp => {
    if (resp.status() >= 400 && !resp.url().endsWith("/favicon.ico"))
      report.errors.push(`${resp.status()} ${resp.url()}`);
  });

  const id = name => page.locator(`#${name}`);
  const wait = (fn, arg, timeout = 25000) => page.waitForFunction(fn, arg, { timeout });

  await page.goto(baseUrl);
  await wait(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);

  // Verify strobe starts hidden before chase
  const initialStrobe = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    return {
      exists: Boolean(el),
      hidden: el?.hidden ?? null,
      mode: el?.dataset.mode ?? null,
    };
  });
  assert.equal(initialStrobe.exists, true);
  assert.equal(initialStrobe.hidden, true);

  // 1. Start Level 5 Max RL Chase and verify tactical police specs + HOT Red/Blue Strobe!
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  await id("pursuitRunBtn").click();

  await wait(() =>
    window.sim.world.pursuit?.phase === "running" &&
    window.sim.world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1" &&
    window.sim.world.pursuit?.frozenDriver?.decisions >= 12 &&
    document.getElementById("pursuitStrobe")?.dataset.mode === "hot",
  );

  // Let RL chase run live for ~3.5 seconds across Grand Metro City v5!
  await page.waitForTimeout(3500);

  report.sustainedTacticalChase = await page.evaluate(() => {
    const { world } = window.sim;
    const p = world.pursuit;
    const patrols = [...p.patrols].filter(u => u.aiState !== "WRECKED");
    return {
      tacticalPursuit: p.gta.config.tacticalPursuit,
      wantedLevel: p.wantedLevel,
      wantedLevelMax: p.gta.config.wantedLevelMax,
      activePatrols: patrols.length,
      unitBreakdown: patrols.reduce((acc, u) => {
        acc[u.unitType] = (acc[u.unitType] ?? 0) + 1;
        return acc;
      }, {}),
      samplePatrolSpecs: patrols.slice(0, 4).map(u => ({
        id: u.id,
        unitType: u.unitType,
        squadRole: u.squadRole,
        aiState: u.aiState,
        maxSpeedMps: Number(u.maxSpeed.toFixed(2)),
        acceleration: u.spec?.acceleration,
        steerRate: u.spec?.steerRate,
      })),
      maxPatrolTopSpeedMps: Math.max(...patrols.map(u => u.maxSpeed)),
      egoMaxSpeedMps: world.player.maxSpeed,
      distanceM: Number(p.metrics.distanceM.toFixed(1)),
      shoulderEntries: p.metrics.shoulderEntries,
      pedestrianCollisions: p.metrics.pedestrianCollisions,
    };
  });
  assert.equal(report.sustainedTacticalChase.tacticalPursuit, "gta-tactical-v1");
  assert.ok(report.sustainedTacticalChase.maxPatrolTopSpeedMps > report.sustainedTacticalChase.egoMaxSpeedMps);
  assert.equal(report.sustainedTacticalChase.pedestrianCollisions, 0);

  // Ensure visual contact right now to capture crisp hot-pursuit Red & Blue screen-edge strobe!
  await page.evaluate(() => {
    const { world } = window.sim;
    const p = world.pursuit;
    const ego = world.player;
    const car = [...p.patrols].find(u => u.aiState !== "WRECKED");
    if (car) {
      // Position patrol 20 m directly behind ego in clear sight for hot-pursuit frame
      const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
      car.x = ego.x - sin * 20;
      car.z = ego.z - cos * 20;
      car.heading = ego.heading;
      car.speed = Math.max(22, ego.speed);
    }
  });
  await page.waitForTimeout(250);

  report.hotPursuitStrobe = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    const intensity = Number(el.style.getPropertyValue("--strobe-intensity"));
    const cycleMs = el.style.getPropertyValue("--strobe-cycle-ms");
    return {
      hidden: el.hidden,
      mode: el.dataset.mode,
      activeHotMode: !el.hidden && el.dataset.mode === "hot" && intensity >= 0.55,
      intensity,
      cycleMs,
      wantedText: document.getElementById("pursuitWanted")?.textContent ?? "",
      phaseText: document.getElementById("pursuitPhase")?.textContent ?? "",
    };
  });
  assert.equal(report.hotPursuitStrobe.activeHotMode, true);
  await page.screenshot({ path: join(outDir, "tactical-hot-pursuit-strobe.png") });

  // 2. Restart a 2-star chase in Manual mode so we can deterministically verify out-of-sight Strobe Calming + Star-by-Star Decay -> Escaped in live Chromium!
  await id("pursuitRestartBtn").click();
  await wait(() => !window.sim.world.pursuit || window.sim.world.pursuit.phase !== "running");

  await id("pakoDriverManual").click();
  await id("pursuitLevel").selectOption("2");
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running" && window.sim.world.pursuit.wantedLevel === 2);

  // Qualify pursuit briefly in sight (1.2s), then move ego > 150 m behind distant buildings out of sight!
  await page.evaluate(() => {
    const { world } = window.sim;
    const ego = world.player;
    const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
    for (const car of world.pursuit.patrols) {
      car.x = ego.x - sin * 24;
      car.z = ego.z - cos * 24;
      car.heading = ego.heading;
      car.speed = 16;
    }
  });
  await page.waitForTimeout(1300);

  // Move patrols >= 220 m away behind distant Grand City v5 buildings (keeping ego right in place so camera stays locked smoothly on the SUV!)
  await page.evaluate(() => {
    const { world } = window.sim;
    // Advance ego 62 m straight down its current heading so camera stays centered behind the SUV AND physical distance from lastSeen exceeds 48 m!
    const sinH = Math.sin(world.player.heading), cosH = Math.cos(world.player.heading);
    const egoX = world.player.x + sinH * 62;
    const egoZ = world.player.z + cosH * 62;
    world.player.x = egoX;
    world.player.z = egoZ;
    world.player.speed = 0;
    world.player.previous = { ...world.player };

    // Keep patrols >= 240 m away on the opposite corner of Grand City v5 out of line-of-sight
    const oppRoad = world.drivingRoads
      .filter(r => !r.parkingBay && !r.supportApron && r.axis !== "diag")
      .sort((a, b) => {
        const ax = a.axis === "x" ? (a.min + a.max) / 2 : a.fixed;
        const az = a.axis === "z" ? (a.min + a.max) / 2 : a.fixed;
        const bx = b.axis === "x" ? (b.min + b.max) / 2 : b.fixed;
        const bz = b.axis === "z" ? (b.min + b.max) / 2 : b.fixed;
        return Math.hypot(bx - egoX, bz - egoZ) - Math.hypot(ax - egoX, az - egoZ);
      })[0];
    const oppMid = (oppRoad.min + oppRoad.max) / 2;
    const px = oppRoad.axis === "x" ? oppMid : oppRoad.fixed;
    const pz = oppRoad.axis === "z" ? oppMid : oppRoad.fixed;
    const movePatrolsFar = () => {
      if (!window.sim.world.pursuit || window.sim.world.pursuit.phase !== "running") return false;
      let idx = 0;
      for (const car of window.sim.world.pursuit.patrols) {
        car.x = px + (idx++) * 8;
        car.z = pz;
        car.speed = 0;
      }
      return true;
    };
    movePatrolsFar();
    // Place lastSeen >= 75 m away AFTER patrols are already out of sight so open-road separation holds cleanly
    if (world.pursuit?.response) {
      world.pursuit.response.unitsInContact = 0;
      world.pursuit.response.sightedBy?.clear?.();
      if (world.pursuit.response.dispatch) {
        world.pursuit.response.dispatch.state = "SEARCHING";
      }
    }
    window.__pinPatrolsFar = setInterval(() => {
      if (!movePatrolsFar()) clearInterval(window.__pinPatrolsFar);
    }, 80);
  });

  // First observe immediate strobe calming in SEARCHING mode right after losing line of sight!
  await wait(() => {
    const el = document.getElementById("pursuitStrobe");
    return el?.dataset.mode === "searching" && Number(el.style.getPropertyValue("--strobe-intensity")) <= 0.38;
  }, null, 6000);

  const searchingSample = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    return {
      mode: el.dataset.mode,
      intensity: Number(el.style.getPropertyValue("--strobe-intensity")),
      cycleMs: el.style.getPropertyValue("--strobe-cycle-ms"),
      phaseText: document.getElementById("pursuitPhase")?.textContent ?? "",
      sceneText: document.getElementById("pursuitScene")?.textContent ?? "",
    };
  });

  // Wait for SEARCHING -> COOLING_DOWN & 2★ -> 1★ star drop!
  await wait(() => {
    const el = document.getElementById("pursuitStrobe");
    const p = window.sim.world.pursuit;
    return p?.phase === "running" &&
      p.wantedLevel === 1 &&
      el?.dataset.mode === "cooling";
  }, null, 15000);

  report.outOfSightCooldown = await page.evaluate((sSample) => {
    const el = document.getElementById("pursuitStrobe");
    const intensity = Number(el.style.getPropertyValue("--strobe-intensity"));
    const coolingStarCount = document.querySelectorAll("#pursuitWanted .pursuit-star--cooling").length;
    return {
      searchingTransition: sSample,
      mode: el.dataset.mode,
      intensity,
      cycleMs: el.style.getPropertyValue("--strobe-cycle-ms"),
      strobeCalmedDown:
        sSample.intensity <= 0.38 &&
        intensity > 0 &&
        intensity <= 0.18 &&
        intensity < sSample.intensity,
      wantedLevelNow: window.sim.world.pursuit?.wantedLevel,
      wantedText: document.getElementById("pursuitWanted")?.textContent ?? "",
      coolingStarCount,
      phaseText: document.getElementById("pursuitPhase")?.textContent ?? "",
      sceneText: document.getElementById("pursuitScene")?.textContent ?? "",
      learningText: document.getElementById("pursuitLearning")?.textContent ?? "",
      starDecayObserved: window.sim.world.pursuit?.wantedLevel === 1 && coolingStarCount === 1,
    };
  }, searchingSample);
  assert.equal(report.outOfSightCooldown.strobeCalmedDown, true);
  assert.equal(report.outOfSightCooldown.starDecayObserved, true);
  await page.screenshot({ path: join(outDir, "tactical-cooldown-faded-strobe.png") });

  // Wait for final star 1★ -> 0★ -> ESCAPED and verify strobe turns completely OFF!
  await wait(() => window.sim.world.pursuit?.phase === "escaped", null, 12000);
  await page.waitForTimeout(250);

  report.escapedState = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    return {
      pursuitPhase: window.sim.world.pursuit?.phase ?? null,
      strobeHidden: el?.hidden ?? null,
      strobeMode: el?.dataset.mode ?? null,
      phaseBadge: document.getElementById("pursuitPhase")?.textContent ?? "",
    };
  });
  assert.equal(report.escapedState.pursuitPhase, "escaped");
  assert.equal(report.escapedState.strobeHidden, true);
  assert.equal(report.escapedState.strobeMode, "off");
  await page.screenshot({ path: join(outDir, "tactical-escaped-clean.png") });

  assert.equal(report.errors.length, 0, `Unexpected browser/network errors: ${report.errors.join("; ")}`);
  report.passed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProc.exitCode === null) serverProc.kill();
  writeFileSync(join(outDir, "tactical-chase-browser.json"), JSON.stringify(report, null, 2));
}

console.log("Headed tactical chase browser check:", JSON.stringify(report, null, 2));
if (!report.passed) process.exit(1);
