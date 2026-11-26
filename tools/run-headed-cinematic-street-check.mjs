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
  : resolve(rootDir, ".runtime-proof/cinematic-grade-street-realism-20261124/headed-browser");
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
      srv.close((err) => (err ? rej(err) : res(port)));
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
    await new Promise((r) => setTimeout(r, 300));
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

let browser = null;
const report = { passed: false, errors: [], ownedServerPid: serverProc.pid };

try {
  await waitForServer(baseUrl, serverProc);
  browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(25000);
  page.on("pageerror", (err) => report.errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") report.errors.push(`console.error: ${msg.text()}`);
  });
  page.on("response", (resp) => {
    if (resp.status() >= 400 && !resp.url().endsWith("/favicon.ico")) {
      report.errors.push(`${resp.status()} ${resp.url()}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.sim?.defaultChaseReady === true && window.sim?.renderDiagnostics?.()?.renderedFrames >= 12,
    null,
    { timeout: 25000 },
  );

  // Helper that reads WebGL scene pixels directly on thenext animation frame (excluding bottom-left preview box)
  const measureSceneCanvasPixels = async () =>
    page.evaluate(
      () =>
        new Promise((resolveMeasure) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const sceneCanvas = document.querySelector("canvas.scene");
              const off = document.createElement("canvas");
              const sw = 320;
              const sh = 180;
              off.width = sw;
              off.height = sh;
              const ctx = off.getContext("2d", { willReadFrequently: true });
              ctx.drawImage(sceneCanvas, 0, 0, sw, sh);
              const data = ctx.getImageData(0, 0, sw, sh).data;
              const lumas = [];
              let sumLuma = 0;
              let sumSat = 0;
              let centerSum = 0;
              let centerN = 0;
              let cornerSum = 0;
              let cornerN = 0;
              for (let y = 0; y < sh; y++) {
                for (let x = 0; x < sw; x++) {
                  // Exclude bottom-left ungraded sensor preview scissor rect (x < 78, y > 108)
                  if (x < 82 && y > 106) continue;
                  const i = (y * sw + x) * 4;
                  const r = data[i] / 255;
                  const g = data[i + 1] / 255;
                  const b = data[i + 2] / 255;
                  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                  const mx = Math.max(r, g, b);
                  const mn = Math.min(r, g, b);
                  const sat = mx <= 1e-5 ? 0 : (mx - mn) / mx;
                  lumas.push(luma);
                  sumLuma += luma;
                  sumSat += sat;
                  const u = x / sw;
                  const v = y / sh;
                  const rad = Math.hypot(u - 0.5, v - 0.5);
                  if (rad < 0.18) {
                    centerSum += luma;
                    centerN++;
                  } else if (rad > 0.54 && v < 0.72) {
                    cornerSum += luma;
                    cornerN++;
                  }
                }
              }
              lumas.sort((a, b) => a - b);
              const n = lumas.length || 1;
              const p10 = lumas[Math.floor(n * 0.10)] ?? 0;
              const p95 = lumas[Math.floor(n * 0.95)] ?? 0;
              resolveMeasure({
                meanLuma: Number((sumLuma / n).toFixed(4)),
                meanSaturation: Number((sumSat / n).toFixed(4)),
                p10Luma: Number(p10.toFixed(4)),
                p95Luma: Number(p95.toFixed(4)),
                contrastSpanP95P10: Number((p95 - p10).toFixed(4)),
                centerMeanLuma: Number((centerSum / Math.max(1, centerN)).toFixed(4)),
                cornerMeanLuma: Number((cornerSum / Math.max(1, cornerN)).toFixed(4)),
              });
            });
          });
        }),
    );

  // Close side drawers if open so full wide cinematic city frame is unobstructed
  await page.evaluate(() => {
    const closeBtn = document.querySelector("#vehiclePanelClose");
    if (closeBtn && !closeBtn.closest("[hidden]")) closeBtn.click();
  });
  await page.waitForTimeout(350);

  // 1. Boulevard Cinematic Grade, Dusk Lamps, Manholes & Segmented Curbs Shot (mid-block avenue on pure dark bitumen asphalt)
  const boulevardSetup = await page.evaluate(() => {
    const w = window.sim.world;
    const manholes = window.sim.view?.streetSurfaces?.root?.userData?.manholeCenters ?? [];
    const cobbles = w.terrain?.cobbleZones ?? [];
    const inCobble = (x, z) =>
      cobbles.some((c) => Math.hypot(x - c.x, z - c.z) < Math.max(c.halfWidth ?? 8, c.halfLength ?? 18) + 18);
    // Pick a mid-block avenue manhole away from major crosswalks so open asphalt, manholes, curbs, lamps & shops shine
    const mh =
      manholes.find(
        (m) =>
          Math.abs(m.x) < 240 &&
          Math.abs(m.z) > 35 &&
          Math.abs(m.z) < 210 &&
          !inCobble(m.x, m.z),
      ) ??
      manholes[0] ??
      { x: w.player.x, z: w.player.z + 10 };
    w.player.x = mh.x + 1.35;
    w.player.z = mh.z - 5.2;
    w.player.previous = { ...w.player };
    w.player.heading = 0;
    w.player.speed = 9.5;
    w.player.vehicle.speed = 9.5;
    w.player.vehicle.controls.brake = 0.25;
    window.sim.step(3);
    return {
      cinematic: window.sim.cinematicDiagnostics(),
      street: window.sim.streetSurfaceDiagnostics(),
      render: window.sim.renderDiagnostics(),
    };
  });
  await page.waitForTimeout(450);
  const boulevardPixels = await measureSceneCanvasPixels();
  await page.screenshot({ path: join(outDir, "cinematic-cairo-boulevard-grade.png") });

  report.boulevardCurbAndGradeCheck = {
    passed:
      boulevardPixels.meanLuma >= 0.08 &&
      boulevardPixels.meanLuma <= 0.36 &&
      boulevardPixels.meanSaturation <= 0.28 &&
      boulevardPixels.contrastSpanP95P10 >= 0.34 &&
      boulevardPixels.cornerMeanLuma < boulevardPixels.centerMeanLuma &&
      boulevardSetup.cinematic.post?.enabled === true &&
      boulevardSetup.cinematic.atmosphere?.hasCinematicRoadPbr === true &&
      boulevardSetup.street?.manholeCount >= 35,
    pixels: boulevardPixels,
    cinematic: boulevardSetup.cinematic,
    manholeCount: boulevardSetup.street?.manholeCount,
    lampPoolCount: boulevardSetup.street?.lampPoolCount,
  };

  // 2. Wet Asphalt Dusk Puddle Reflections, Splash & Warm Headlamp Pools Shot
  const wetCheck = await page.evaluate(async () => {
    const w = window.sim.world;
    const puddle =
      w.terrain.waterPuddles.find((p) => p.halfLength >= 7.5) ?? w.terrain.waterPuddles[0];
    const h = puddle.heading ?? 0;
    w.player.x = puddle.x - Math.sin(h) * 5.0;
    w.player.z = puddle.z - Math.cos(h) * 5.0;
    w.player.previous = { ...w.player };
    w.player.heading = h;
    w.player.speed = 13.5;
    w.player.vehicle.speed = 13.5;
    await new Promise((r) => setTimeout(r, 320));
    return {
      surface: w.player.vehicle?.surface ?? null,
      surfDiag: window.sim.streetSurfaceDiagnostics(),
      pixelsReady: true,
    };
  });
  const wetPixels = await measureSceneCanvasPixels();
  await page.screenshot({ path: join(outDir, "cinematic-wet-asphalt-reflections.png") });

  report.wetPuddleDuskReflectionsCheck = {
    passed:
      wetPixels.meanLuma <= 0.36 &&
      wetPixels.meanSaturation <= 0.29 &&
      (wetCheck.surfDiag?.activeWaterSplashes ?? 0) > 0,
    pixels: wetPixels,
    activeWaterSplashes: wetCheck.surfDiag?.activeWaterSplashes ?? 0,
    surface: wetCheck.surface,
  };

  // 3. Close Street-Level Curb Stones, Sidewalk Tiles, Storm Drain & Tree Grate Shot (sunlit east curb face)
  const curbDetailCheck = await page.evaluate(async () => {
    const w = window.sim.world;
    const ave = w.drivingRoads.find((r) => r.zone === "avenue" && r.axis === "z") ?? w.drivingRoads[0];
    // East sidewalk (+X) faces the western raking sun (-114, 58, -70) so curb blocks, storm drains, tiles & shops catch crisp raking light
    const curbX = (ave.fixed ?? 0) + ave.width * 0.5 - 2.1;
    const curbZ = (ave.min + ave.max) * 0.5 + 18;
    w.player.x = curbX;
    w.player.z = curbZ;
    w.player.previous = { ...w.player };
    w.player.heading = 0.34;
    w.player.speed = 3.2;
    w.player.vehicle.controls.brake = 0.75;
    await new Promise((r) => setTimeout(r, 360));
    const archCounts = window.sim.view?.egyptStreets?.diagnostics?.counts ?? {};
    return {
      drains: archCounts.drains ?? 0,
      curbSegments: archCounts.curbSegments ?? 0,
      shops: archCounts.shops ?? 0,
      balconies: archCounts.balconies ?? 0,
    };
  });
  await page.screenshot({ path: join(outDir, "realistic-curb-sidewalk-details.png") });

  report.sidewalkCurbCloseDetailCheck = {
    passed:
      curbDetailCheck.drains >= 400 &&
      curbDetailCheck.curbSegments >= 50 &&
      curbDetailCheck.shops > 0,
    ...curbDetailCheck,
  };

  // 4. High-Speed 5-Star Cinematic Chase Motion (reset to clear open boulevard lane first, then launch 5-star chase!)
  await page.evaluate(() => {
    window.sim.reset({ cityVersion: 5, seed: "cairo-cinematic-chase" });
  });
  await page.waitForFunction(
    () => window.sim?.defaultChaseReady === true && window.sim?.renderDiagnostics?.()?.renderedFrames >= 4,
    null,
    { timeout: 15000 },
  );
  await page.locator("#pakoBtn").click();
  await page.waitForSelector("#pursuitRunBtn", { state: "visible" });
  await page.locator("#pursuitLevel").selectOption("5");
  await page.locator("#pursuitRunBtn").click();
  await page.locator("#pakoBtn").click(); // Collapse panel so full chase action fills viewport

  const chaseMotionCheck = await page.evaluate(async () => {
    window.sim.setChaseCameraStyle("chasing");
    const w = window.sim.world;
    let peakFov = 62;
    let peakAbsRoll = 0;
    let peakStreak = 0;
    const deadline = performance.now() + 2600;
    while (performance.now() < deadline) {
      if (w.pursuit?.phase === "running") {
        // Inject brisk high-speed S-curve cornering pulse if speed dips so camera banking & speed FOV are captured live
        if (Math.abs(w.player.speed) < 15.5) {
          w.player.speed = 17.2;
          w.player.vehicle.speed = 17.2;
        }
        w.player.heading += 0.019;
        w.player.chaseSlip = -0.18;
      }
      await new Promise((r) => requestAnimationFrame(r));
      const diag = window.sim.cinematicDiagnostics();
      if (diag.camera.fov > peakFov) peakFov = diag.camera.fov;
      if (Math.abs(diag.camera.rollRad) > peakAbsRoll) peakAbsRoll = Math.abs(diag.camera.rollRad);
      const streak = diag.post?.lastState?.speedNorm ?? 0;
      if (streak > peakStreak) peakStreak = streak;
      if (peakFov >= 66.2 && peakAbsRoll >= 0.011) break;
    }
    return {
      peakFov: Number(peakFov.toFixed(3)),
      peakAbsRoll: Number(peakAbsRoll.toFixed(4)),
      peakSpeedNorm: Number(peakStreak.toFixed(3)),
      cinematic: window.sim.cinematicDiagnostics(),
      render: window.sim.renderDiagnostics(),
    };
  });
  const chasePixels = await measureSceneCanvasPixels();
  await page.screenshot({ path: join(outDir, "cinematic-chase-motion-banking.png") });

  report.highSpeedCinematicChaseCheck = {
    passed:
      chaseMotionCheck.peakFov >= 65.5 &&
      chaseMotionCheck.peakAbsRoll >= 0.010 &&
      chaseMotionCheck.peakSpeedNorm >= 0.70 &&
      chasePixels.meanLuma <= 0.38,
    ...chaseMotionCheck,
    pixels: chasePixels,
  };

  report.passed =
    report.errors.length === 0 &&
    report.boulevardCurbAndGradeCheck.passed &&
    report.wetPuddleDuskReflectionsCheck.passed &&
    report.sidewalkCurbCloseDetailCheck.passed &&
    report.highSpeedCinematicChaseCheck.passed;
} finally {
  writeFileSync(join(outDir, "cinematic-street-browser.json"), JSON.stringify(report, null, 2));
  if (browser) await browser.close().catch(() => {});
  if (serverProc.pid && serverProc.exitCode === null) {
    try {
      process.kill(serverProc.pid);
    } catch {
      // ignore
    }
  }
}

console.log(
  JSON.stringify({
    passed: report.passed,
    errors: report.errors.length,
    boulevardLuma: report.boulevardCurbAndGradeCheck?.pixels?.meanLuma,
    boulevardSat: report.boulevardCurbAndGradeCheck?.pixels?.meanSaturation,
    boulevardContrast: report.boulevardCurbAndGradeCheck?.pixels?.contrastSpanP95P10,
    chasePeakFov: report.highSpeedCinematicChaseCheck?.peakFov,
    chasePeakRoll: report.highSpeedCinematicChaseCheck?.peakAbsRoll,
  }),
);
assert.equal(report.passed, true, `Headed cinematic browser check failed: ${JSON.stringify(report.errors)}`);
