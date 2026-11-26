import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clickCityTool } from "./city-tool-button.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/realistic-city-surfaces-20261123/headed-browser");
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
  page.on("response", (resp) => {
    if (resp.status() >= 400 && !resp.url().endsWith("/favicon.ico")) {
      report.errors.push(`${resp.status()} ${resp.url()}`);
    }
  });

  const id = (name) => page.locator(`#${name}`);
  const wait = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout });

  await page.goto(baseUrl);
  await wait(() => window.sim?.view?.actorDiagnostics?.().ready && window.sim?.defaultChaseReady === true);

  // Open Car panel so #carSurfaceStatus is live and visible alongside the 3D Cairo street!
  await clickCityTool(page, "carToggleBtn");
  await page.waitForTimeout(350);

  // 1. Cairo Realistic Apartment Buildings (العمارات) & Storefronts (المحلات) + Street Lamps & Trees Shot!
  await page.evaluate(() => {
    const { world } = window.sim;
    // Frame along dense Cairo apartment & shopfront block on Tahrir Boulevard (east of Tahrir Plaza, x ~ -485 -> -445 or x ~ 14 -> 62)
    // and clear any ambient traffic within 22 m so the SUV has an unobstructed view!
    const px = 14, pz = -112 + 2.7;
    for (const actor of world.actors) {
      if (actor === world.player) continue;
      if (Math.hypot(actor.x - px, actor.z - pz) < 24) {
        actor.x -= 55;
        delete actor.previous;
      }
    }
    Object.assign(world.player, {
      x: px,
      z: pz,
      heading: Math.PI / 2 - 0.16,
      speed: 0,
      steer: 0,
      path: [],
    });
    delete world.player.previous;
    world.command({ type: "stop" });
  });
  await page.waitForTimeout(550);

  report.buildingsAndShopsCheck = await page.evaluate(() => {
    const arch = window.sim.view.egyptStreets.diagnostics;
    const surf = window.sim.streetSurfaceDiagnostics?.() ?? {};
    return {
      passed:
        arch.budget.withinBudget === true &&
        arch.counts.balconies >= 30 &&
        arch.counts.airConditioners >= 15 &&
        arch.counts.awnings >= 10 &&
        arch.counts.shops >= 20 &&
        (surf.streetLampCount ?? 0) >= 20 &&
        (surf.streetTreeCount ?? 0) >= 20,
      withinBudget: arch.budget.withinBudget,
      drawCalls: arch.drawCalls,
      triangles: arch.triangles,
      counts: arch.counts,
      streetLamps: surf.streetLampCount ?? 0,
      streetTrees: surf.streetTreeCount ?? 0,
      streetFurniture: surf.furnitureCount ?? 0,
      surfaceLayerDiagnostics: surf,
      architectureBudget: arch.budget,
      residentCells: arch.residentCells,
      totalCells: arch.totalCells,
    };
  });
  await page.screenshot({ path: join(outDir, "cairo-apartments-and-shops.png") });

  // 2. Street Standing Water Puddles (المية في الشارع) + Tire Water Splash Spray + Wet Traction Physics!
  await page.evaluate(() => {
    const { world } = window.sim;
    const puddle = world.terrain.waterPuddles[0]; // tahrir-west-puddle (-172, -109.5)
    const h = puddle.heading;
    Object.assign(world.player, {
      x: puddle.x - Math.sin(h) * 4.5,
      z: puddle.z - Math.cos(h) * 4.5,
      heading: h,
      speed: 12.5,
      steer: 0.14,
      path: [],
    });
    delete world.player.previous;
    world.command({ type: "drive", targetSpeed: 13, steer: 0.14 });
  });
  await wait(() =>
    document.getElementById("carSurfaceStatus")?.dataset?.surface === "water" &&
    (window.sim?.streetSurfaceDiagnostics?.()?.activeWaterSplashes ?? 0) >= 4,
  );
  await page.waitForTimeout(180);

  report.waterPuddleSplashCheck = await page.evaluate(() => {
    const surfDiag = window.sim.streetSurfaceDiagnostics?.() ?? {};
    const hudEl = document.getElementById("carSurfaceStatus");
    const vehSurf = window.sim.world.player.vehicle?.surface;
    return {
      passed:
        hudEl?.dataset?.surface === "water" &&
        (surfDiag.activeWaterSplashes ?? 0) >= 4 &&
        (vehSurf?.gripMultiplier ?? 1) <= 0.7,
      hudText: hudEl?.textContent ?? "",
      hudSurface: hudEl?.dataset?.surface ?? "",
      activeWaterSplashes: surfDiag.activeWaterSplashes ?? 0,
      waterRoughness: surfDiag.waterRoughness ?? 1,
      gripMultiplier: vehSurf?.gripMultiplier ?? 1,
    };
  });
  await page.screenshot({ path: join(outDir, "street-water-puddles-splash.png") });

  // 3. Sandy Street & Drifts (شوارع رملية) + Rippled Sand PBR + Tire Dust Plumes + Sand Drag Physics!
  await page.evaluate(() => {
    const { world } = window.sim;
    const sand = world.terrain.sandZones.find((z) => z.id === "souq-west-sand-stretch") ?? world.terrain.sandZones[0];
    const h = sand.heading;
    Object.assign(world.player, {
      x: sand.x - Math.sin(h) * 8,
      z: sand.z - Math.cos(h) * 8,
      heading: h,
      speed: 12.0,
      steer: -0.18,
      path: [],
    });
    delete world.player.previous;
    world.command({ type: "drive", targetSpeed: 13.5, steer: -0.18 });
  });
  await wait(() =>
    document.getElementById("carSurfaceStatus")?.dataset?.surface === "sand" &&
    (window.sim?.streetSurfaceDiagnostics?.()?.activeSandDust ?? 0) >= 2,
  );
  await page.waitForTimeout(220);

  report.sandyStreetDustCheck = await page.evaluate(() => {
    const surfDiag = window.sim.streetSurfaceDiagnostics?.() ?? {};
    const hudEl = document.getElementById("carSurfaceStatus");
    const vehSurf = window.sim.world.player.vehicle?.surface;
    return {
      passed:
        hudEl?.dataset?.surface === "sand" &&
        (surfDiag.activeSandDust ?? 0) >= 2 &&
        (vehSurf?.rollingDragMps2 ?? 0) >= 1.0 &&
        (vehSurf?.gripMultiplier ?? 1) <= 0.78,
      hudText: hudEl?.textContent ?? "",
      hudSurface: hudEl?.dataset?.surface ?? "",
      activeSandDust: surfDiag.activeSandDust ?? 0,
      sandRoughness: surfDiag.sandRoughness ?? 0,
      rollingDragMps2: vehSurf?.rollingDragMps2 ?? 0,
      gripMultiplier: vehSurf?.gripMultiplier ?? 1,
    };
  });
  await page.screenshot({ path: join(outDir, "sandy-street-dust-drift.png") });

  // 4. Elevated Overpass Ramp & Slopes (المنحدرات والمرتفعات) during Live Level 5 Police Chase!
  // Move player onto the west approach of Tahrir Overpass Ramp BEFORE starting Chase so pursuitCamera & patrols frame the 3.2m overpass cleanly!
  await page.evaluate(() => {
    const { world } = window.sim;
    Object.assign(world.player, {
      x: -46,
      z: -112 + 2.7,
      heading: Math.PI / 2,
      speed: 14.0,
      steer: 0,
      path: [],
    });
    delete world.player.previous;
  });
  await page.waitForTimeout(200);

  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  await id("pursuitRunBtn").click();
  await wait(() =>
    window.sim?.world?.pursuit?.phase === "running" &&
    (window.sim?.world?.pursuit?.patrols?.size ?? 0) >= 2,
  );

  // Stage pursuing cruisers climbing right behind the SUV on Tahrir Overpass Ramp (x ~ -36 -> +24, z = -112)
  await page.evaluate(() => {
    const { world } = window.sim;
    const ego = world.player;
    Object.assign(ego, {
      x: -36,
      z: -112 + 2.7,
      heading: Math.PI / 2,
      speed: 15.0,
      steer: 0,
    });
    delete ego.previous;
    const patrols = [...world.pursuit.patrols];
    if (patrols[0]) {
      Object.assign(patrols[0], { x: -50, z: -112 + 1.2, heading: Math.PI / 2, speed: 17.5 });
      delete patrols[0].previous;
    }
    if (patrols[1]) {
      Object.assign(patrols[1], { x: -58, z: -112 + 4.1, heading: Math.PI / 2, speed: 18.0 });
      delete patrols[1].previous;
    }
  });
  await wait(() => {
    const surf = window.sim?.world?.player?.vehicle?.surface;
    const statusEl = document.getElementById("pursuitSurfaceStatus");
    return Boolean(
      surf &&
      surf.elevationM >= 1.1 &&
      Math.abs(surf.gradePct) >= 3.0 &&
      statusEl &&
      statusEl.offsetParent !== null &&
      statusEl.textContent.length > 0,
    );
  });
  await page.waitForTimeout(240);

  report.elevatedSlopeCheck = await page.evaluate(() => {
    const playerRoot = window.sim.view.roots.get("player")?.root;
    const camPos = window.sim.renderDiagnostics().cameraPosition;
    const camDistToPlayerM = playerRoot
      ? Math.hypot(camPos[0] - playerRoot.position.x, camPos[2] - playerRoot.position.z)
      : Infinity;
    const vehSurf = window.sim.world.player.vehicle?.surface;
    const statusEl = document.getElementById("pursuitSurfaceStatus");
    const pursuitSurfVisible = Boolean(statusEl && statusEl.offsetParent !== null);
    const pursuitSurfText = statusEl?.textContent || "";
    return {
      passed:
        Boolean(vehSurf && vehSurf.elevationM >= 1.1 && Math.abs(surfGrade(vehSurf)) >= 3.0) &&
        (playerRoot?.position?.y ?? 0) >= 1.2 &&
        Math.abs(playerRoot?.rotation?.x ?? 0) >= 0.025 &&
        camDistToPlayerM <= 32 &&
        pursuitSurfVisible &&
        pursuitSurfText.includes("Uphill"),
      elevationM: vehSurf?.elevationM ?? 0,
      gradePct: vehSurf?.gradePct ?? 0,
      renderedPlayerY: Number((playerRoot?.position?.y ?? 0).toFixed(3)),
      renderedPitchRad: Number((playerRoot?.rotation?.x ?? 0).toFixed(4)),
      camDistToPlayerM: Number(camDistToPlayerM.toFixed(2)),
      pursuitSurfVisible,
      pursuitSurfaceText: pursuitSurfText,
    };
    function surfGrade(s) {
      return s?.gradePct ?? 0;
    }
  });
  await page.screenshot({ path: join(outDir, "elevated-ramp-slope-vista.png") });

  report.passed =
    report.errors.length === 0 &&
    report.buildingsAndShopsCheck.passed &&
    report.waterPuddleSplashCheck.passed &&
    report.sandyStreetDustCheck.passed &&
    report.elevatedSlopeCheck.passed;

  writeFileSync(join(outDir, "city-surfaces-browser.json"), JSON.stringify(report, null, 2));
  console.log("Headed browser city buildings, surfaces & slopes check:", JSON.stringify({
    passed: report.passed,
    errors: report.errors.length,
    buildingsPassed: report.buildingsAndShopsCheck.passed,
    waterPassed: report.waterPuddleSplashCheck.passed,
    sandPassed: report.sandyStreetDustCheck.passed,
    slopePassed: report.elevatedSlopeCheck.passed,
  }));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill();
  }
}

if (!report.passed) {
  process.exit(1);
}
