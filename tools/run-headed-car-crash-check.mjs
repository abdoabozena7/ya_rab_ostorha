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
  : resolve(rootDir, ".runtime-proof/car-crash-parts-20261123/headed-browser");
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

  // 1. Open Car panel, enter Controlled Impact Bay, switch to Inspect + Body Cutaway to inspect rich authored mechanical/exterior details!
  await clickCityTool(page, "carToggleBtn");
  await id("carImpactBayBtn").click();
  await wait(() => window.sim?.world?.environment === "vehicle" && window.sim?.world?.vehicleTest?.phase === "ready");
  await page.locator('button[data-car-view="inspection"]').click();
  await id("carCutaway").check();
  await page.waitForTimeout(450);

  report.pristineInspection = await page.evaluate(() => {
    const root = window.sim.vehicleRig.root;
    const partText = document.getElementById("carPartDamage")?.textContent ?? "";
    const damagedAttr = document.getElementById("carPartDamage")?.dataset?.damaged;
    return {
      environment: window.sim.world.environment,
      cutaway: window.sim.vehicleRig.diagnostics.cutaway,
      partDamageText: partText,
      damagedAttr,
      hasRadiatorCore: Boolean(root.getObjectByName("suv-radiator-core")),
      hasCrashBar: Boolean(root.getObjectByName("suv-crash-bar")),
      hasBattery: Boolean(root.getObjectByName("suv-battery-box")),
      hasDualExhaust: Boolean(root.getObjectByName("suv-exhaust-left") && root.getObjectByName("suv-exhaust-right")),
      hasTowHooks: Boolean(root.getObjectByName("suv-tow-hook-left") && root.getObjectByName("suv-tow-hook-right")),
    };
  });
  await page.screenshot({ path: join(outDir, "suv-detailed-pristine-inspect.png") });

  // 2. Uncheck cutaway and trigger "Heavy crash (50 km/h)" in the Controlled Impact Bay!
  await id("carCutaway").uncheck();
  await id("carHeavyImpactBtn").click();
  await wait(() =>
    (window.sim?.world?.player?.vehicle?.damage?.brokenCount ?? 0) >= 3 &&
    ((window.sim?.crashDiagnostics?.()?.activeDebrisParts ?? 0) >= 1 ||
     (window.sim?.crashDiagnostics?.()?.activeSmokePuffs ?? 0) >= 1),
  );
  // Wait briefly after impact so buckled hood, radiator smoke, and scattered 3D car parts are clearly visible in frame, then switch to Inspect angle!
  await page.waitForTimeout(320);
  await page.locator('button[data-car-view="inspection"]').click();
  await page.waitForTimeout(260);

  report.heavyImpactBay = await page.evaluate(() => {
    const dmg = window.sim.world.player.vehicle.damage;
    const rigDmg = window.sim.vehicleRig.diagnostics.damage;
    const fx = window.sim.crashDiagnostics?.() ?? {};
    const partEl = document.getElementById("carPartDamage");
    const hoodPivot = window.sim.vehicleRig.root.getObjectByName("suv-hood-pivot");
    const wsCracks = window.sim.vehicleRig.root.getObjectByName("suv-windshield-cracks");
    return {
      phase: window.sim.world.vehicleTest?.phase,
      frontDamage: Number((dmg.front ?? 0).toFixed(3)),
      brokenPartsCount: Math.max(dmg.brokenCount ?? 0, rigDmg.brokenParts?.length ?? 0),
      detachedPartsCount: Math.max(dmg.detachedCount ?? 0, rigDmg.detachedParts?.length ?? 0),
      rigBrokenParts: rigDmg.brokenParts ?? [],
      rigDetachedParts: rigDmg.detachedParts ?? [],
      hoodBuckledRad: Number(Math.abs(hoodPivot?.rotation?.x ?? 0).toFixed(4)),
      windshieldCracksVisible: Boolean(wsCracks?.visible),
      panelPartDamageText: partEl?.textContent ?? "",
      panelDamagedFlag: partEl?.dataset?.damaged,
      crashEffects: fx,
      debrisOrSmokeActive: Boolean((fx.activeDebrisParts ?? 0) > 0 || (fx.activeSmokePuffs ?? 0) > 0 || (fx.totalBurstsSpawned ?? 0) > 0),
    };
  });
  await page.screenshot({ path: join(outDir, "suv-heavy-crash-broken-parts.png") });

  // 3. Click "Repair / reset" and verify pristine restoration!
  await id("carResetBtn").click();
  await wait(() =>
    (window.sim?.world?.player?.vehicle?.damage?.brokenCount ?? 0) === 0 &&
    document.getElementById("carPartDamage")?.dataset?.damaged === "false",
  );
  await page.waitForTimeout(200);
  report.repairVerified = await page.evaluate(() => {
    const dmg = window.sim.world.player.vehicle.damage;
    const rigDmg = window.sim.vehicleRig.diagnostics.damage;
    const fx = window.sim.crashDiagnostics?.() ?? {};
    const partEl = document.getElementById("carPartDamage");
    return {
      pristineRestored:
        dmg.total === 0 &&
        dmg.brokenCount === 0 &&
        (rigDmg.brokenParts?.length ?? 0) === 0 &&
        (fx.activeDebrisParts ?? 0) === 0 &&
        partEl?.dataset?.damaged === "false",
      partDamageText: partEl?.textContent ?? "",
      activeDebrisAfterReset: fx.activeDebrisParts ?? 0,
    };
  });

  // 4. Return to Grand Metro City v5, launch Level 5 Police Chase, and verify live cruiser + SUV part-crashing collision with 3D debris & smoke!
  await id("carReturnBtn").click();
  await wait(() => window.sim?.world?.environment === "metro" && window.sim?.view?.actorDiagnostics?.().ready);
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  await id("pursuitRunBtn").click();
  await wait(() =>
    window.sim?.world?.pursuit?.phase === "running" &&
    (window.sim?.world?.pursuit?.patrols?.size ?? 0) >= 2,
  );
  await page.waitForTimeout(900);

  // Stage an immediate dramatic front-quarter pursuit ram with an intercepting police cruiser in view of the chase camera!
  await page.evaluate(() => {
    const { world } = window.sim;
    const ego = world.player;
    const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
    const patrols = [...world.pursuit.patrols];
    if (patrols[0]) {
      ego.speed = Math.max(12, ego.speed);
      patrols[0].x = ego.x + sin * 4.55 + cos * 0.45;
      patrols[0].z = ego.z + cos * 4.55 - sin * 0.45;
      patrols[0].heading = ego.heading + Math.PI - 0.18;
      patrols[0].speed = 19;
      patrols[0].vx = Math.sin(patrols[0].heading) * 19;
      patrols[0].vz = Math.cos(patrols[0].heading) * 19;
      patrols[0].health = 24;
    }
    if (patrols[1]) {
      patrols[1].x = ego.x - sin * 11.5 - cos * 1.9;
      patrols[1].z = ego.z - cos * 11.5 + sin * 1.9;
      patrols[1].heading = ego.heading;
      patrols[1].speed = Math.max(16, ego.speed);
    }
  });

  await wait(() =>
    (window.sim?.world?.player?.vehicle?.damage?.brokenCount ?? 0) >= 1 &&
    (window.sim?.view?.pursuitDiagnostics?.()?.crumpledPatrols ?? 0) >= 1,
  );
  await page.waitForTimeout(260);

  report.cityChaseCollision = await page.evaluate(() => {
    const dmg = window.sim.world.player.vehicle.damage;
    const rigDmg = window.sim.vehicleRig.diagnostics.damage;
    const pDiag = window.sim.view.pursuitDiagnostics?.() ?? {};
    const fx = window.sim.crashDiagnostics?.() ?? {};
    return {
      cruiserAndPlayerDamaged:
        (dmg.brokenCount ?? 0) >= 1 &&
        (pDiag.crumpledPatrols ?? 0) >= 1 &&
        (fx.totalBurstsSpawned ?? 0) >= 1,
      playerBrokenCount: dmg.brokenCount ?? 0,
      playerBrokenParts: rigDmg.brokenParts ?? [],
      crumpledPatrols: pDiag.crumpledPatrols ?? 0,
      crashEffects: fx,
      strobeMode: document.getElementById("pursuitStrobe")?.dataset?.mode ?? "none",
    };
  });
  await page.screenshot({ path: join(outDir, "city-chase-crash-debris-smoke.png") });

  report.passed =
    report.errors.length === 0 &&
    report.pristineInspection.hasRadiatorCore &&
    report.pristineInspection.hasCrashBar &&
    report.heavyImpactBay.brokenPartsCount >= 3 &&
    report.heavyImpactBay.debrisOrSmokeActive === true &&
    report.repairVerified.pristineRestored === true &&
    report.cityChaseCollision.cruiserAndPlayerDamaged === true;

  writeFileSync(join(outDir, "car-crash-browser.json"), JSON.stringify(report, null, 2));
  console.log("Headed browser car crash verification:", JSON.stringify({
    passed: report.passed,
    errors: report.errors.length,
    heavyBrokenParts: report.heavyImpactBay.brokenPartsCount,
    repairRestored: report.repairVerified.pristineRestored,
    cityChaseDamaged: report.cityChaseCollision.cruiserAndPlayerDamaged,
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
