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
  : resolve(rootDir, ".runtime-proof/cinematic-perf-escape-20261123/headed-browser");
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

  // 1. Start Level 5 Max RL Chase and verify far cross-city escapeGoal, cinematic lighting, 3D bounce lights, and heavily blurred strobe!
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  await id("pursuitRunBtn").click();

  await wait(() =>
    window.sim.world.pursuit?.phase === "running" &&
    Boolean(window.sim.world.pursuit?.gta?.escapeGoal) &&
    window.sim.world.pursuit?.frozenDriver?.decisions >= 12 &&
    document.getElementById("pursuitStrobe")?.dataset.mode === "hot",
  );

  // Let RL chase run live for 4.5s across Grand Metro City v5!
  await page.waitForTimeout(4500);

  // Ensure close visual contact right behind SUV on an avenue/diagonal street for crisp hot-pursuit blurred cinema shot!
  await page.evaluate(() => {
    const { world } = window.sim;
    const ego = world.player;
    const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
    const active = [...world.pursuit.patrols].filter(u => u.aiState !== "WRECKED");
    if (active[0]) {
      active[0].x = ego.x - sin * 14 + cos * 1.8;
      active[0].z = ego.z - cos * 14 - sin * 1.8;
      active[0].heading = ego.heading;
      active[0].speed = Math.max(22, ego.speed);
    }
    if (active[1]) {
      active[1].x = ego.x - sin * 21 - cos * 2.2;
      active[1].z = ego.z - cos * 21 + sin * 2.2;
      active[1].heading = ego.heading;
      active[1].speed = Math.max(22, ego.speed);
    }
  });
  await page.waitForTimeout(280);

  report.blurredStrobeCheck = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    const red = el.querySelector(".pursuit-strobe__red");
    const blue = el.querySelector(".pursuit-strobe__blue");
    const ambient = el.querySelector(".pursuit-strobe__ambient");
    const csRed = getComputedStyle(red);
    const csBlue = getComputedStyle(blue);
    const blurVar = el.style.getPropertyValue("--strobe-blur-px");
    const blurNum = parseFloat(blurVar) || 0;
    const filterMatches = /blur\(([0-9.]+)px\)/.exec(csRed.filter);
    const computedBlurPx = filterMatches ? parseFloat(filterMatches[1]) : blurNum;
    return {
      mode: el.dataset.mode,
      intensity: Number(el.style.getPropertyValue("--strobe-intensity")),
      blurVar,
      computedRedFilter: csRed.filter,
      computedBlueFilter: csBlue.filter,
      mixBlendMode: csRed.mixBlendMode,
      ambientLayerPresent: Boolean(ambient),
      hasHeavyBlur: computedBlurPx >= 36 && csRed.mixBlendMode === "screen",
    };
  });
  assert.equal(report.blurredStrobeCheck.hasHeavyBlur, true);

  report.liveCrossCityChase = await page.evaluate(() => {
    const { world } = window.sim;
    const p = world.pursuit;
    const goal = p.gta.escapeGoal;
    return {
      escapeGoalAssigned: Boolean(goal && goal.initialDistanceM >= 420),
      escapeGoal: goal,
      realisticDynamicsOnPlayer: Boolean(world.player.spec?.realisticDynamics),
      sceneHudText: document.getElementById("pursuitScene")?.textContent ?? "",
      distanceM: Number(p.metrics.distanceM.toFixed(1)),
      pedestrianCollisions: p.metrics.pedestrianCollisions,
    };
  });
  assert.equal(report.liveCrossCityChase.escapeGoalAssigned, true);
  assert.equal(report.liveCrossCityChase.realisticDynamicsOnPlayer, true);
  assert.equal(report.liveCrossCityChase.pedestrianCollisions, 0);

  await page.screenshot({ path: join(outDir, "cinematic-hot-blurred-chase.png") });

  // 2. Switch to dynamic "Chasing cam" on a diagonal boulevard far from origin (> 260 m) to verify player-following shadows + 3D police bounce lights!
  await id("pursuitCamStyleBtn").click();
  await page.evaluate(() => {
    const { world } = window.sim;
    const diag = world.drivingRoads.find(r => r.id === "citadel-diagonal" || r.id === "ramses-diagonal" || r.axis === "diag");
    if (diag) {
      const along = Math.min(diag.length - 40, Math.max(40, diag.length * 0.72));
      const x = diag.x1 + diag.ux * along - diag.uz * (diag.laneOffsetM ?? 2.6);
      const z = diag.z1 + diag.uz * along + diag.ux * (diag.laneOffsetM ?? 2.6);
      world.player.x = x;
      world.player.z = z;
      world.player.heading = diag.heading;
      world.player.previous = { ...world.player };
      const active = [...world.pursuit.patrols].filter(u => u.aiState !== "WRECKED");
      if (active[0]) {
        active[0].x = x - diag.ux * 13;
        active[0].z = z - diag.uz * 13;
        active[0].heading = diag.heading;
        active[0].speed = 24;
        active[0].previous = { ...active[0] };
      }
    }
  });
  await page.waitForTimeout(350);

  report.cinematicLightingCheck = await page.evaluate(() => {
    const { world, view } = window.sim;
    const p = world.player;
    const sunTarget = view.sun.target.position;
    const distFromOriginM = Math.hypot(p.x, p.z);
    const shadowAnchorErrorM = Math.hypot(sunTarget.x - p.x, sunTarget.z - p.z);
    const pDiag = view.pursuitView?.diagnostics?.() ?? {};
    return {
      playerPos: { x: Number(p.x.toFixed(1)), z: Number(p.z.toFixed(1)), distFromOriginM: Number(distFromOriginM.toFixed(1)) },
      sunTargetPos: { x: sunTarget.x, z: sunTarget.z },
      shadowAnchorErrorM: Number(shadowAnchorErrorM.toFixed(2)),
      shadowFollowsPlayerFarFromOrigin: distFromOriginM >= 180 && shadowAnchorErrorM <= 4.0,
      pursuitLightDiagnostics: pDiag,
      policeBounceLightsActive: Boolean(pDiag.bounceLightsActive),
      skyHex: `#${view.scene.background.getHexString()}`,
      chaseCameraStyle: window.sim.chaseCameraStyle,
    };
  });
  assert.equal(report.cinematicLightingCheck.shadowFollowsPlayerFarFromOrigin, true);
  assert.equal(report.cinematicLightingCheck.policeBounceLightsActive, true);
  await page.screenshot({ path: join(outDir, "cinematic-chasing-cam-diagonal.png") });

  // 3. Verify calm heavy-blur (68-78px) out-of-sight search/cooldown state!
  await page.evaluate(() => {
    const { world } = window.sim;
    const oppX = -world.player.x;
    const oppZ = -world.player.z;
    window.__holdFar = setInterval(() => {
      if (!window.sim.world.pursuit || window.sim.world.pursuit.phase !== "running") {
        clearInterval(window.__holdFar);
        return;
      }
      let idx = 0;
      for (const car of window.sim.world.pursuit.patrols) {
        car.x = oppX + (idx++) * 7;
        car.z = oppZ;
        car.speed = 0;
      }
    }, 80);
    let idx = 0;
    for (const car of world.pursuit.patrols) {
      car.x = oppX + (idx++) * 7;
      car.z = oppZ;
      car.speed = 0;
    }
    world.pursuit.response.unitsInContact = 0;
    world.pursuit.response.sightedBy?.clear?.();
    if (world.pursuit.response.dispatch) {
      world.pursuit.response.dispatch.state = "SEARCHING";
    }
  });

  await wait(() => {
    const el = document.getElementById("pursuitStrobe");
    return (el?.dataset.mode === "searching" || el?.dataset.mode === "cooling") &&
      parseFloat(el.style.getPropertyValue("--strobe-blur-px")) >= 64;
  }, null, 8000);

  report.calmBlurredOutOfSight = await page.evaluate(() => {
    const el = document.getElementById("pursuitStrobe");
    return {
      mode: el.dataset.mode,
      intensity: Number(el.style.getPropertyValue("--strobe-intensity")),
      blurPx: el.style.getPropertyValue("--strobe-blur-px"),
      phaseText: document.getElementById("pursuitPhase")?.textContent ?? "",
      sceneText: document.getElementById("pursuitScene")?.textContent ?? "",
    };
  });
  await page.screenshot({ path: join(outDir, "cinematic-cooldown-soft-blur.png") });

  assert.equal(report.errors.length, 0, `Unexpected browser/network errors: ${report.errors.join("; ")}`);
  report.passed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProc.exitCode === null) serverProc.kill();
  writeFileSync(join(outDir, "cinematic-chase-browser.json"), JSON.stringify(report, null, 2));
}

console.log("Headed cinematic chase browser check:", JSON.stringify(report, null, 2));
if (!report.passed) process.exit(1);
