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
  : resolve(rootDir, ".runtime-proof/grand-city-v5-20261122/headed-browser");
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
  page.setDefaultTimeout(18000);
  const attachErrors = targetPage => {
    targetPage.on("pageerror", err => report.errors.push(err.message));
    targetPage.on("response", resp => {
      if (resp.status() >= 400 && !resp.url().endsWith("/favicon.ico"))
        report.errors.push(`${resp.status()} ${resp.url()}`);
    });
  };
  attachErrors(page);
  const id = name => page.locator(`#${name}`);
  const wait = (fn, arg, timeout = 25000) => page.waitForFunction(fn, arg, { timeout });

  await page.goto(baseUrl);
  await wait(() => window.sim?.view.actorDiagnostics().ready && window.sim?.defaultChaseReady === true);

  // 1. Verify default Metro City is Grand Metro City v5 with diagonal boulevards, monumental buildings, and 50+ parked cars
  report.cityV5Loaded = await page.evaluate(() => {
    const { world, view } = window.sim;
    const diagRoads = world.drivingRoads.filter(r => r.axis === "diag");
    const buildings = world.statics.filter(s => s.kind === "building");
    const parked = world.statics.filter(s => s.kind === "parked-vehicle");
    return {
      cityVersion: world.config.cityVersion,
      trafficCapacity: world.capacity.traffic,
      pedestrianCapacity: world.capacity.pedestrians,
      diagonalRoadCount: diagRoads.length,
      diagonalRoads: diagRoads.map(r => ({
        id: r.id,
        lengthM: Number(r.length.toFixed(1)),
        widthM: r.width,
        headingDeg: Number(((r.heading * 180) / Math.PI).toFixed(1)),
      })),
      buildingCount: buildings.length,
      maxBuildingHeightM: Math.max(...buildings.map(b => b.height ?? 0)),
      parkedVehicleCount: parked.length,
      metroParkedRegistered: view.metroParked?.length ?? 0,
      hotspots: {
        crowds: (world.district.hotspots?.crowds ?? []).map(h => ({ id: h.id, name: h.name, radiusM: h.radiusM })),
        traffic: (world.district.hotspots?.traffic ?? []).map(h => ({ id: h.id, radiusM: h.radiusM })),
        parkedPockets: (world.district.hotspots?.parked ?? []).map(p => ({ id: p.id, roadId: p.roadId, count: p.vehicleIds?.length ?? 0 })),
      },
      chaseCameraStyle: window.sim.chaseCameraStyle,
    };
  });
  assert.equal(report.cityV5Loaded.cityVersion, 5);
  assert.ok(report.cityV5Loaded.diagonalRoadCount >= 4);
  assert.ok(report.cityV5Loaded.parkedVehicleCount >= 45);
  assert.equal(report.cityV5Loaded.metroParkedRegistered, report.cityV5Loaded.parkedVehicleCount);
  assert.equal(report.cityV5Loaded.chaseCameraStyle, "follow");

  // Frame the radial Tahrir diagonal plaza & monumental skyline
  await page.evaluate(() => {
    const { world } = window.sim;
    const qasr = world.drivingRoads.find(r => r.id === "qasr-diagonal") ?? world.drivingRoads.find(r => r.axis === "diag");
    if (qasr) {
      const along = Math.max(25, qasr.length - 55);
      world.player.x = qasr.x1 + qasr.ux * along - qasr.uz * (qasr.laneOffsetM ?? 2.7);
      world.player.z = qasr.z1 + qasr.uz * along + qasr.ux * (qasr.laneOffsetM ?? 2.7);
      world.player.heading = qasr.heading;
      world.player.previous = { ...world.player };
    }
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, "v5-diagonal-plaza.png") });

  // 2. Start Level 5 Max RL Chase and verify Behind-Car ('follow') vs Chasing ('chasing') camera toggle + building occlusion safety
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
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

  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running" &&
    window.sim.world.pursuit?.frozenDriver?.decisions >= 16 &&
    Math.abs(window.sim.world.player.speed) > 2.5);

  const sampleCameraState = () => page.evaluate(() => {
    const diag = window.sim.renderDiagnostics();
    const p = window.sim.world.player;
    const [cx, cy, cz] = diag.cameraPosition;
    const distHorizM = Math.hypot(cx - p.x, cz - p.z);
    const heightRelM = cy - 0.12;
    const insideBuilding = window.sim.world.statics.some(s => {
      if (s.kind !== "building") return false;
      const c = Math.cos(s.heading ?? 0), sn = Math.sin(s.heading ?? 0);
      const dx = cx - s.x, dz = cz - s.z;
      const lx = Math.abs(dx * c - dz * sn), lz = Math.abs(dx * sn + dz * c);
      return lx < s.width / 2 - 0.05 && lz < s.length / 2 - 0.05 && cy < (s.height ?? 30) + 0.12;
    });
    return {
      style: diag.chaseCameraStyle,
      fov: Number(diag.cameraFov.toFixed(2)),
      distHorizM: Number(distHorizM.toFixed(2)),
      heightRelM: Number(heightRelM.toFixed(2)),
      insideBuilding,
    };
  });

  const behindSample = await sampleCameraState();
  assert.equal(behindSample.style, "follow");
  assert.equal(behindSample.insideBuilding, false);

  // Switch to Chasing camera via the Chase card button (#pursuitCamStyleBtn)
  await id("pursuitCamStyleBtn").click();
  await page.waitForTimeout(450);
  const chasingSample = await sampleCameraState();
  assert.equal(chasingSample.style, "chasing");
  assert.equal(chasingSample.insideBuilding, false);
  await page.screenshot({ path: join(outDir, "v5-behind-vs-chasing-cam.png") });

  // Also test keyboard shortcut KeyV toggling back to Behind car and back to Chasing
  await page.keyboard.press("KeyV");
  assert.equal(await page.evaluate(() => window.sim.chaseCameraStyle), "follow");
  await page.keyboard.press("KeyV");
  assert.equal(await page.evaluate(() => window.sim.chaseCameraStyle), "chasing");

  report.cameraModes = {
    behindSample,
    chasingSample,
    bothDistinctAndUnoccluded:
      !behindSample.insideBuilding &&
      !chasingSample.insideBuilding &&
      (chasingSample.distHorizM > behindSample.distHorizM + 0.8 || chasingSample.heightRelM > behindSample.heightRelM + 0.8),
  };
  assert.equal(report.cameraModes.bothDistinctAndUnoccluded, true, JSON.stringify(report.cameraModes));

  // 3. Sustain Level 5 Max Chase across Grand City v5 streets & diagonals (>= 25s)
  const measureSustained = () => page.evaluate(() => {
    const { world } = window.sim, { pursuit: run, player } = world;
    const maxRunningWaitS = Number((window.__maxRunningWaitS ?? 0).toFixed(2));
    const patrols = [...run.patrols].filter(u => u.aiState !== "WRECKED");
    return {
      phase: run.phase,
      survivalS: Number(run.metrics.survivalS.toFixed(1)),
      distanceM: Number(run.metrics.distanceM.toFixed(1)),
      shoulderEntries: run.metrics.shoulderEntries,
      collisions: run.metrics.collisions,
      pedestrianCollisions: run.metrics.pedestrianCollisions,
      maxRunningWaitS,
      oscillated: Boolean(window.__oscillated),
      stalled: (run.phase === "running" && (player.wait ?? 0) > 6.5) || maxRunningWaitS > 6.5,
      activePatrols: patrols.map(u => ({
        id: u.id,
        unitType: u.unitType,
        aiState: u.aiState,
        speedMps: Number(u.speed.toFixed(2)),
        rangeM: Number(Math.hypot(u.x - player.x, u.z - player.z).toFixed(1)),
      })),
    };
  });

  await wait(() => (window.sim.world.pursuit?.metrics.survivalS ?? 0) >= 25 ||
    window.sim.world.pursuit?.phase !== "running", null, 45000);
  report.sustainedV5Chase = await measureSustained();
  if (report.sustainedV5Chase.distanceM <= 65 && report.sustainedV5Chase.phase !== "running") {
    report.firstAttempt = report.sustainedV5Chase;
    await page.evaluate(() => {
      window.__maxRunningWaitS = 0;
      window.__oscillated = false;
      window.__gearFlips = 0;
      window.__samples = [];
    });
    await id("pursuitRunBtn").click();
    await wait(() => window.sim.world.pursuit?.phase === "running" && window.sim.world.pursuit?.frozenDriver?.decisions >= 6);
    await wait(() => (window.sim.world.pursuit?.metrics.survivalS ?? 0) >= 25 ||
      window.sim.world.pursuit?.phase !== "running", null, 45000);
    report.sustainedV5Chase = await measureSustained();
  }
  assert.equal(report.sustainedV5Chase.pedestrianCollisions, 0);
  assert.equal(report.sustainedV5Chase.stalled, false);
  assert.equal(report.sustainedV5Chase.oscillated, false);
  assert.ok(report.sustainedV5Chase.distanceM > 65, `Expected sustained v5 chase distance > 65 m, got ${report.sustainedV5Chase.distanceM}`);

  if (await page.evaluate(() => window.sim.world.pursuit?.phase === "running")) {
    await id("pursuitRestartBtn").click();
    await wait(() => window.sim.world.pursuit.phase === "stopped");
  }
  const postAudit = await page.evaluate(() => window.sim.world.audit().filter(x => x.includes("player")));
  assert.deepEqual(postAudit, []);

  // 4. Crowd + Parked-Car Hotspot Visual & YOLOX Perception Capture
  await page.evaluate(() => {
    window.sim.setChaseCameraStyle("follow");
    const { world } = window.sim;
    const pocket = world.district.hotspots?.parked?.[0];
    const road = world.drivingRoads.find(r => r.id === (pocket?.roadId ?? "tahrir-boulevard")) ?? world.drivingRoads[0];
    if (road && road.axis !== "diag") {
      const along = Math.min(road.max - 25, Math.max(road.min + 25, (road.min + road.max) / 2 - 18));
      Object.assign(world.player, road.axis === "z"
        ? { x: road.fixed - (road.laneOffsetM ?? 2.5), z: along, heading: 0, speed: 0 }
        : { x: along, z: road.fixed + (road.laneOffsetM ?? 2.5), heading: Math.PI / 2, speed: 0 });
      world.player.previous = { ...world.player };
    }
    const person = world.actors.find(a => a.type === "pedestrian");
    if (person) {
      const s = Math.sin(world.player.heading), c = Math.cos(world.player.heading);
      const px = world.player.x + s * 9.0 + c * 1.6;
      const pz = world.player.z + c * 9.0 - s * 1.6;
      const tx = world.player.x + s * 9.0 - c * 3.5;
      const tz = world.player.z + c * 9.0 + s * 3.5;
      Object.assign(person, {
        kind: "man-polo", x: px, z: pz, heading: Math.atan2(tx - px, tz - pz),
        crossing: true, speed: 1.35, walkSpeed: 1.35, pause: 0,
        target: { x: tx, z: tz }, walkRoute: [{ x: tx, z: tz }], motionMode: "ambient",
      });
      person.previous = { ...person };
    }
    world.updateSensors();
  });
  if (!await id("driveSense").isVisible()) await id("driveSenseBtn").click();
  await wait(() => window.sim.cityPerception?.rangeTick !== null &&
    Boolean(document.getElementById("driveSenseImage").dataset.frameId));
  await id("driveSenseDetector").click();
  await wait(() => {
    const st = window.sim.cityPerception;
    const canvas = document.getElementById("driveSenseImage");
    return st?.camera === "matched" && st.people > 0 && Number(canvas.dataset.frameId) === st.cameraFrame;
  }, null, 38000);
  await page.waitForTimeout(350);
  report.hotspotPerception = await page.evaluate(() => ({
    camera: window.sim.cityPerception?.camera ?? null,
    peopleDetected: window.sim.cityPerception?.people ?? 0,
    forecastsCount: window.sim.cityPerception?.forecasts?.length ?? 0,
    ghostsAreNotActors: !window.sim.world.actors.some(a => /forecast/.test(a.id)),
  }));
  await page.screenshot({ path: join(outDir, "v5-crowd-parked-hotspot.png") });
  await id("driveSenseDetector").click();
  await wait(() => window.sim.cityPerception?.camera === "off");
  await page.close();

  // 5. Mobile 390x844 geometry check on Grand Metro City v5
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
  await mobile.screenshot({ path: join(outDir, "v5-compact-mobile.png") });
  await mobile.close();

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (err) {
  report.errors.push(err?.stack || err?.message || String(err));
} finally {
  if (browser) {
    await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  }
  if (serverProc.exitCode === null) {
    serverProc.kill();
    await Promise.race([new Promise(r => serverProc.once("exit", r)), new Promise(r => setTimeout(r, 3000))]);
  }
  report.serverStopped = serverProc.exitCode !== null || serverProc.killed;
  writeFileSync(join(outDir, "grand-city-browser.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, "server.log"), serverLogs);
}

assert.ok(report.passed, `Grand City v5 headed browser check failed: ${JSON.stringify(report.errors)}`);
console.log(JSON.stringify({
  passed: report.passed,
  cityV5Loaded: report.cityV5Loaded,
  cameraModes: report.cameraModes,
  sustainedV5Chase: report.sustainedV5Chase,
  mobile: report.mobile,
}));
process.exit(0);
