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
  : resolve(rootDir, ".runtime-proof/vehicle-surface-object-interactions-20261124/headed-browser");
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
  browser = await chromium.launch({
    headless: false,
    args: [
      "--force-device-scale-factor=1",
      "--ignore-gpu-blocklist",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
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

  // Close vehicle side panel if open so full wide frame is clear
  await page.evaluate(() => {
    const closeBtn = document.querySelector("#vehiclePanelClose");
    if (closeBtn && !closeBtn.closest("[hidden]")) closeBtn.click();
  });

  const startManualChaseFromUi = async () => {
    await page.evaluate(() => {
      const btn = document.getElementById("pakoBtn");
      if (btn && btn.getAttribute("aria-expanded") !== "true") btn.click();
      const manualBtn = document.getElementById("pakoDriverManual");
      if (manualBtn) manualBtn.click();
      const runBtn = document.getElementById("pursuitRunBtn");
      if (runBtn) runBtn.click();
      if (btn && btn.getAttribute("aria-expanded") === "true") btn.click();
    });
  };

  const stopManualChaseFromUi = async () => {
    await page.evaluate(() => {
      const btn = document.getElementById("pakoBtn");
      if (btn && btn.getAttribute("aria-expanded") !== "true") btn.click();
      const stopBtn = document.getElementById("pursuitRestartBtn");
      if (stopBtn) stopBtn.click();
      if (btn && btn.getAttribute("aria-expanded") === "true") btn.click();
    });
  };

  const ensureAmbientManualFromUi = async () => {
    await page.evaluate(() => {
      if (window.sim.world.mode === "auto") {
        document.getElementById("aiToggleBtn")?.click();
      }
    });
  };

  // 0. 100% Untouched Initial-Load Default-UI Journey (ZERO window.sim.reset() calls, ZERO setting/pose/speed/damage edits!)
  await startManualChaseFromUi();
  await page.keyboard.down("KeyW");
  let defaultSpawnCheck;
  try {
    await page.evaluate(async () => {
      for (let f = 0; f < 220; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (Math.abs(window.sim.world.player.speed ?? 0) >= 12.0) break;
      }
    });
    await page.keyboard.down("Space");
    await page.keyboard.down("KeyA");
    defaultSpawnCheck = await page.evaluate(async () => {
      let peakSpeedMps = 0;
      let peakSmoke = 0;
      let peakSkids = 0;
      for (let f = 0; f < 36; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        const sp = Math.abs(window.sim.world.player.speed ?? 0);
        if (sp > peakSpeedMps) peakSpeedMps = sp;
        const cd = window.sim.crashDiagnostics();
        if ((cd?.activeSmoke ?? 0) > peakSmoke) peakSmoke = cd.activeSmoke;
        if ((cd?.activeSkidSegments ?? 0) > peakSkids) peakSkids = cd.activeSkidSegments;
        if (peakSmoke >= 8 && peakSkids >= 8) break;
      }
      // Verify ongoing advancing unanalysed front-camera frames in "What the car sees" (#driveSense) with detector OFF!
      let dsFirstFrameId = 0;
      for (let f = 0; f < 45; f++) {
        const dsImg = document.getElementById("driveSenseImage");
        if (dsImg && !dsImg.hidden && Number(dsImg.dataset.frameId) >= 1) {
          dsFirstFrameId = Number(dsImg.dataset.frameId);
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      let dsSecondFrameId = dsFirstFrameId;
      for (let f = 0; f < 50; f++) {
        const dsImg = document.getElementById("driveSenseImage");
        const fid = Number(dsImg?.dataset?.frameId ?? 0);
        if (dsImg && !dsImg.hidden && fid > dsFirstFrameId) {
          dsSecondFrameId = fid;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      const dsImg = document.getElementById("driveSenseImage");
      const dsEmpty = document.getElementById("driveSenseEmpty");
      return {
        defaultTrafficActors: window.sim.world.actors.length,
        peakSpeedMps: Number(peakSpeedMps.toFixed(3)),
        peakSmoke,
        peakSkids,
        detectorEnabled: Boolean(window.sim.vision?.status?.status === "ready"),
        driveSensePreviewLive: Boolean(
          dsImg && !dsImg.hidden && dsFirstFrameId >= 1 && dsSecondFrameId > dsFirstFrameId && dsEmpty?.hidden === true,
        ),
        driveSenseFirstFrameId: dsFirstFrameId,
        driveSenseFrameId: dsSecondFrameId,
      };
    });
  } finally {
    await page.keyboard.up("KeyA").catch(() => {});
    await page.keyboard.up("Space").catch(() => {});
    await page.keyboard.up("KeyW").catch(() => {});
  }
  await stopManualChaseFromUi();
  report.unforcedDefaultSpawnJourneyCheck = {
    passed:
      defaultSpawnCheck.defaultTrafficActors >= 10 &&
      defaultSpawnCheck.peakSpeedMps >= 6.5 &&
      defaultSpawnCheck.peakSmoke >= 4 &&
      defaultSpawnCheck.peakSkids >= 6 &&
      defaultSpawnCheck.detectorEnabled === false &&
      defaultSpawnCheck.driveSensePreviewLive === true,
    ...defaultSpawnCheck,
  };

  // 1. 100% Untouched Default-Spawn Continuous Puddle Crossing (ZERO w.player pose/speed/damage writes!):
  // Drive straight east from default spawn (-254, -109.3) through tahrir-west-puddle (-156, -109.2) onto dry asphalt (-146)
  // right beside tahrir-gutter-puddle (-142, -114.6)!
  await page.evaluate(async () => {
    window.sim.reset({ cityVersion: 5, speedLimit: 90, traffic: 0, pedestrians: 0, seed: "water-fresnel-shot" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await ensureAmbientManualFromUi();
  await page.keyboard.down("KeyW");
  let waterCheck;
  try {
    waterCheck = await page.evaluate(async () => {
      const w = window.sim.world;
      let peakRipples = 0;
      let peakSpray = 0;
      let peakWetTracks = 0;
      for (let f = 0; f < 2800; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        const d = window.sim.streetSurfaceDiagnostics();
        if ((d?.activeWaterRipples ?? 0) > peakRipples) peakRipples = d.activeWaterRipples;
        if ((d?.activeWaterSplashes ?? 0) > peakSpray) peakSpray = d.activeWaterSplashes;
        if ((d?.activeWetTrackSegments ?? 0) > peakWetTracks) peakWetTracks = d.activeWetTrackSegments;
        // Pause right as all 4 wheels emerge onto dry asphalt (x >= -146.8) so 4 wet tracks trail behind the rear bumper while ripples & spray remain live in the puddle!
        if (w.player.x >= -146.8 && peakWetTracks >= 12 && (d?.activeWaterSplashes ?? 0) >= 6) break;
      }
      window.sim.pause(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { peakRipples, peakSpray, peakWetTracks, diagAtShot: window.sim.streetSurfaceDiagnostics() };
    });
  } finally {
    await page.keyboard.up("KeyW").catch(() => {});
  }
  await page.screenshot({ path: join(outDir, "fresnel-water-ripples-wet-tracks.png") });
  const waterDeltaCheck = await page.evaluate(async () => {
    const w = window.sim.world;
    const grabPatchNextFrame = (x, y, pw, ph) =>
      new Promise((resolvePatch) => {
        requestAnimationFrame(() => {
          const sceneCanvas = document.querySelector("canvas.scene");
          const off = document.createElement("canvas");
          off.width = 320;
          off.height = 180;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(sceneCanvas, 0, 0, 320, 180);
          resolvePatch(ctx.getImageData(x, y, pw, ph).data);
        });
      });
    const meanAbsDiff = (a, b) => {
      let diff = 0;
      for (let i = 0; i < a.length; i += 4) {
        diff += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
      }
      return diff / (a.length / 4);
    };
    const fullRoadPatch = await grabPatchNextFrame(36, 86, 248, 86);
    let sumLuma = 0;
    let maxPxLuma = 0;
    for (let i = 0; i < fullRoadPatch.length; i += 4) {
      const l = (0.2126 * fullRoadPatch[i] + 0.7152 * fullRoadPatch[i + 1] + 0.0722 * fullRoadPatch[i + 2]) / 255;
      sumLuma += l;
      if (l > maxPxLuma) maxPxLuma = l;
    }
    const puddleMeanLuma = Number((sumLuma / (fullRoadPatch.length / 4)).toFixed(4));

    const ss = window.sim.view.streetSurfaces;
    const puddleMesh = ss.root.getObjectByName("street-water-puddles");
    ss.waterRipples.visible = false;
    ss.waterSplashes.visible = false;
    const noSprayRipplePatch = await grabPatchNextFrame(36, 86, 248, 86);
    const sprayAndRipplePixelDelta = Number(meanAbsDiff(fullRoadPatch, noSprayRipplePatch).toFixed(4));

    if (puddleMesh) puddleMesh.visible = false;
    const noPuddlePatch = await grabPatchNextFrame(36, 86, 248, 86);
    const puddleSurfacePixelDelta = Number(meanAbsDiff(noSprayRipplePatch, noPuddlePatch).toFixed(4));

    if (puddleMesh) puddleMesh.visible = true;
    ss.waterRipples.visible = true;
    ss.waterSplashes.visible = true;
    const restoredLowerPatch = await grabPatchNextFrame(108, 122, 104, 52);
    ss.wetTireTracks.visible = false;
    const hiddenWetLowerPatch = await grabPatchNextFrame(108, 122, 104, 52);
    ss.wetTireTracks.visible = true;
    await grabPatchNextFrame(108, 122, 104, 52);
    const wetTracksPixelDelta = Number(meanAbsDiff(restoredLowerPatch, hiddenWetLowerPatch).toFixed(4));

    return {
      puddleMeanLuma,
      puddleMaxLuma: Number(maxPxLuma.toFixed(4)),
      puddleSurfacePixelDelta,
      sprayAndRipplePixelDelta,
      wetTracksPixelDelta,
      brakeState: w.player.vehicle?.controls?.brake ?? 0,
    };
  });
  waterCheck = { ...waterCheck, ...waterDeltaCheck, diag: waterCheck.diagAtShot };
  await page.evaluate(() => window.sim.pause(false));

  report.fresnelWaterRipplesAndWetTracksCheck = {
    passed:
      waterCheck.peakRipples >= 4 &&
      waterCheck.peakSpray >= 8 &&
      waterCheck.peakWetTracks >= 4 &&
      waterCheck.puddleMeanLuma <= 0.42 &&
      waterCheck.puddleSurfacePixelDelta >= 0.0035 &&
      waterCheck.wetTracksPixelDelta >= 0.002 &&
      waterCheck.brakeState === 0 &&
      waterCheck.diag?.hasFresnelWaterShader === true,
    ...waterCheck,
  };

  // 2. 100% Untouched Default-Spawn Drive to tahrir-sand-drift (-108, -110.2) + Tight Low-Speed Turn (ZERO w.player writes!):
  // Carves FOUR Widely Separated Individual Curved Sand Grooves (R ~ 4.4 m -> 90 cm axle off-tracking!) paused MID-TURN!
  await page.evaluate(async () => {
    window.sim.reset({ cityVersion: 5, speedLimit: 90, traffic: 0, pedestrians: 0, seed: "sand-ruts-shot" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await ensureAmbientManualFromUi();
  await page.keyboard.down("KeyW");
  let sandCheck;
  try {
    // Drive straight down Tahrir Boulevard from untouched spawn (-254) until approaching tahrir-sand-drift (-125)
    await page.evaluate(async () => {
      const w = window.sim.world;
      for (let f = 0; f < 2400; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (w.player.x >= -124.0) break;
      }
    });
    // Coast down to ~4.8 m/s while angling slightly left (KeyA) to enter the wide sand drift with room for a full right turn!
    await page.keyboard.up("KeyW");
    await page.keyboard.down("KeyA");
    await page.evaluate(async () => {
      const w = window.sim.world;
      for (let f = 0; f < 120; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (w.player.x >= -117.5 || (w.player.speed ?? 0) <= 5.0) break;
      }
    });
    await page.keyboard.up("KeyA");

    // Full-lock KeyD right turn at ~4.5-5.4 m/s inside tahrir-sand-drift, paused MID-TURN!
    await page.keyboard.down("KeyD");
    await page.keyboard.down("KeyW");
    sandCheck = await page.evaluate(async () => {
      const w = window.sim.world;
      let peakRuts = 0;
      let peakDust = 0;
      let peakGrit = 0;
      for (let f = 0; f < 140; f++) {
        if ((w.player.speed ?? 0) > 5.4) window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));
        else if ((w.player.speed ?? 0) < 4.2) window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
        await new Promise((r) => requestAnimationFrame(r));
        const d = window.sim.streetSurfaceDiagnostics();
        if ((d?.activeSandRutSegments ?? 0) > peakRuts) peakRuts = d.activeSandRutSegments;
        if ((d?.activeSandDust ?? 0) > peakDust) peakDust = d.activeSandDust;
        if ((d?.activeSandGrit ?? 0) > peakGrit) peakGrit = d.activeSandGrit;
        if (f >= 32 && peakRuts >= 24 && peakDust >= 8) break;
      }
      // Release turn key & hold KeyW for 2 frames right before pause so driverCommand throttle is active (brakeState === 0!)
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.sim.pause(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        peakRuts,
        peakDust,
        peakGrit,
        brakeState: w.player.vehicle?.controls?.brake ?? 0,
        diagAtShot: window.sim.streetSurfaceDiagnostics(),
      };
    });
  } finally {
    await page.keyboard.up("KeyA").catch(() => {});
    await page.keyboard.up("KeyD").catch(() => {});
    await page.keyboard.up("KeyW").catch(() => {});
  }
  await page.screenshot({ path: join(outDir, "sand-carved-ruts-and-dust.png") });
  const sandDeltaCheck = await page.evaluate(async () => {
    const grabSandPatch = () =>
      new Promise((resPatch) => {
        requestAnimationFrame(() => {
          const sceneCanvas = document.querySelector("canvas.scene");
          const off = document.createElement("canvas");
          off.width = 320;
          off.height = 180;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(sceneCanvas, 0, 0, 320, 180);
          resPatch(ctx.getImageData(64, 92, 192, 80).data);
        });
      });
    const meanDiff = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) {
        s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
      }
      return s / (a.length / 4);
    };
    const fullPatch = await grabSandPatch();
    window.sim.view.streetSurfaces.sandDust.visible = false;
    window.sim.view.streetSurfaces.sandGrit.visible = false;
    const noDustPatch = await grabSandPatch();
    window.sim.view.streetSurfaces.sandTireRuts.visible = false;
    const noRutsPatch = await grabSandPatch();
    window.sim.view.streetSurfaces.sandDust.visible = true;
    window.sim.view.streetSurfaces.sandGrit.visible = true;
    window.sim.view.streetSurfaces.sandTireRuts.visible = true;
    await grabSandPatch();
    return {
      dustPlumePixelDelta: Number(meanDiff(fullPatch, noDustPatch).toFixed(4)),
      sandRutsPixelDelta: Number(meanDiff(noDustPatch, noRutsPatch).toFixed(4)),
    };
  });
  sandCheck = { ...sandCheck, ...sandDeltaCheck, diag: sandCheck.diagAtShot };
  await page.evaluate(() => window.sim.pause(false));

  report.sandRutsAndDustCloudCheck = {
    passed:
      sandCheck.peakRuts >= 20 &&
      sandCheck.peakDust >= 8 &&
      sandCheck.peakGrit >= 2 &&
      sandCheck.dustPlumePixelDelta >= 0.006 &&
      sandCheck.sandRutsPixelDelta >= 0.006 &&
      sandCheck.brakeState === 0 &&
      sandCheck.diag?.billboardSprayAndDust === true,
    ...sandCheck,
  };

  // 3. 100% Untouched Default-Spawn Crash + High-Speed Hard-Brake Drift (ZERO w.player pose/speed/damage writes!):
  // Step 3a: Start Chase via UI, drive 1.0 s with KeyW and coast into oncoming patrol -> naturally induces front=1.0 & radiator leak!
  // Step 3b: End Chase via UI (#pursuitRunBtn), accelerate down dry Tahrir Boulevard to 10.5 m/s, then slam KeyS + KeyA!
  await page.evaluate(async () => {
    window.sim.reset({ cityVersion: 5, speedLimit: 90, traffic: 0, pedestrians: 0, seed: "volumetric-smoke-shot-2" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await ensureAmbientManualFromUi();
  await startManualChaseFromUi();

  let smokeCheck;
  try {
    // 1. Steer nose-first from untouched spawn (-254, -109.3) straight into grand-parked-tahrir-boulevard-5 (-221, -106.14) at ~13 m/s!
    await page.keyboard.down("KeyW");
    await page.evaluate(async () => {
      const w = window.sim.world;
      const parked = w.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-5") ??
        w.statics.find((a) => a.kind === "parked-vehicle");
      const tx = parked ? parked.x : -221.0;
      const tz = parked ? parked.z : -106.14;
      for (let f = 0; f < 360; f++) {
        const desH = Math.atan2(tx - w.player.x, tz - w.player.z);
        const dh = Math.atan2(Math.sin(desH - w.player.heading), Math.cos(desH - w.player.heading));
        if (dh > 0.02) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
        } else if (dh < -0.02) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
        } else {
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(r));
        if ((w.player.vehicle?.damage?.front ?? 0) >= 0.35 || w.player.vehicle?.damage?.parts?.radiator?.leaking) break;
      }
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
    });
    await page.keyboard.up("KeyW");

    // 2. Stop Chase first (removing pursuit patrols), then reverse STRAIGHT back (KeyS only!) to x <= -232.0 completely clear of the parked sedan!
    await stopManualChaseFromUi();
    await ensureAmbientManualFromUi();

    await page.keyboard.down("KeyS");
    await page.evaluate(async () => {
      const w = window.sim.world;
      for (let f = 0; f < 130; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (w.player.x <= -232.0 && f >= 60) break;
      }
    });
    await page.keyboard.up("KeyS");

    await page.keyboard.down("KeyW");
    await page.evaluate(async () => {
      const w = window.sim.world;
      for (let f = 0; f < 450; f++) {
        const desH = Math.atan2(22.0, -112.2 - w.player.z);
        const dh = Math.atan2(Math.sin(desH - w.player.heading), Math.cos(desH - w.player.heading));
        if (dh > 0.03) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
        } else if (dh < -0.03) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
        } else {
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(r));
        if ((w.player.speed ?? 0) >= 8.2 && w.player.x >= -212.0) break;
      }
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
    });

    // Power-drift (KeyW + KeyA) to keep speed >= 8 m/s while rear tires break traction, then lock brakes (Space + KeyS + KeyA)!
    await page.keyboard.down("KeyA");
    smokeCheck = await page.evaluate(async () => {
      const w = window.sim.world;
      let peakSmoke = 0;
      let peakTireSmoke = 0;
      let peakSkids = 0;
      for (let f = 0; f < 30; f++) {
        if (f === 16) {
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(r));
        const cd = window.sim.crashDiagnostics();
        if ((cd?.activeSmoke ?? 0) > peakSmoke) peakSmoke = cd.activeSmoke;
        if ((cd?.activeTireSmoke ?? 0) > peakTireSmoke) peakTireSmoke = cd.activeTireSmoke;
        if ((cd?.activeSkidSegments ?? 0) > peakSkids) peakSkids = cd.activeSkidSegments;
        if (f >= 12 && peakTireSmoke >= 10 && peakSkids >= 16 && peakSmoke >= 16) break;
      }
      window.sim.pause(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        naturallyInducedFrontDamage: Number((w.player.vehicle?.damage?.front ?? 0).toFixed(4)),
        naturallyInducedRadiatorLeak: Boolean(w.player.vehicle?.damage?.parts?.radiator?.leaking),
        naturallyInducedImpacts: w.player.vehicle?.damage?.impactCount ?? 0,
        peakSmoke,
        peakTireSmoke,
        peakSkids,
        activeWaterRipples: window.sim.streetSurfaceDiagnostics()?.activeWaterRipples ?? 0,
        surfaceKind: w.player.vehicle?.surface?.kind ?? "asphalt",
        crashDiag: window.sim.crashDiagnostics(),
      };
    });
  } finally {
    await page.evaluate(() => {
      for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Space"]) {
        window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
      }
    }).catch(() => {});
    await page.keyboard.up("KeyA").catch(() => {});
    await page.keyboard.up("KeyD").catch(() => {});
    await page.keyboard.up("Space").catch(() => {});
    await page.keyboard.up("KeyS").catch(() => {});
    await page.keyboard.up("KeyW").catch(() => {});
  }
  await page.screenshot({ path: join(outDir, "volumetric-smoke-and-tire-skids.png") });
  await page.evaluate(() => window.sim.pause(false));

  report.volumetricSmokeAndSkidsCheck = {
    passed:
      smokeCheck.naturallyInducedImpacts >= 1 &&
      (smokeCheck.naturallyInducedFrontDamage >= 0.25 || smokeCheck.naturallyInducedRadiatorLeak) &&
      smokeCheck.peakSmoke >= 8 &&
      smokeCheck.peakTireSmoke >= 6 &&
      smokeCheck.peakSkids >= 12 &&
      smokeCheck.activeWaterRipples === 0 &&
      smokeCheck.surfaceKind === "asphalt" &&
      smokeCheck.crashDiag?.smokeIsVolumetricBillboard === true &&
      smokeCheck.crashDiag?.hasSmokeFbmTexture === true,
    ...smokeCheck,
  };

  // 4. 100% Untouched Default-Spawn Sideswipe against grand-parked-tahrir-boulevard-5 (-221, -106.14) (ZERO w.player writes!):
  await page.evaluate(async () => {
    window.sim.reset({ cityVersion: 5, speedLimit: 35, traffic: 0, pedestrians: 0, seed: "wheel-scrape-shot" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = window.sim.world;
    const parked = w.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-5") ??
      w.statics.find((a) => a.kind === "parked-vehicle");
    w._testParked = parked;
    w._origParkedPose = { x: parked.x, z: parked.z, heading: parked.heading };
  });
  await ensureAmbientManualFromUi();
  await page.keyboard.down("KeyW");
  let scrapeCheck;
  try {
    scrapeCheck = await page.evaluate(async () => {
      const w = window.sim.world;
      const parked = w._testParked;
      const origP = w._origParkedPose;
      let sawScrape = false;
      let peakSparks = 0;
      let peakSmoke = 0;
      let peakSkidSegments = 0;
      let peakSymmetricTireSmoke = 0;
      let peakBrakeState = 0;
      let sawParkedRocking = false;
      let parkedMatrixWorldX = 0;
      let parkedMatrixWorldZ = 0;
      let lastActiveScraping = null;
      for (let f = 0; f < 950; f++) {
        let pressD = false;
        if (w.player.x >= parked.x - 8.2 && w.player.x < parked.x + 2.2) {
          if (!sawScrape) {
            pressD = Math.abs(w.player.steer ?? 0) < 0.125;
          } else if (w.player.heading > 1.40 && Math.abs(w.player.steer ?? 0) < 0.18) {
            pressD = true;
          }
        }
        if (pressD) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
        } else {
          window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
        }
        await new Promise((r) => requestAnimationFrame(r));
        const scr = w.player.vehicle?.interaction?.scraping;
        if (scr?.active && scr.kind === "vehicle") {
          sawScrape = true;
          lastActiveScraping = { ...scr };
        }
        const symSmoke = w.player.vehicle?.interaction?.tireSmokeIntensity ?? 0;
        if (symSmoke > peakSymmetricTireSmoke) peakSymmetricTireSmoke = symSmoke;
        const brk = w.player.vehicle?.controls?.brake ?? 0;
        if (brk > peakBrakeState) peakBrakeState = brk;
        const cd = window.sim.crashDiagnostics();
        if ((cd?.activeSparks ?? 0) > peakSparks) peakSparks = cd.activeSparks;
        if ((cd?.activeSmoke ?? 0) > peakSmoke) peakSmoke = cd.activeSmoke;
        if ((cd?.activeSkidSegments ?? 0) > peakSkidSegments) peakSkidSegments = cd.activeSkidSegments;
        const parkedEntry = window.sim.view?.metroParked?.find((p) => p.origSite === parked);
        if (parkedEntry?.root) {
          parkedMatrixWorldX = parkedEntry.root.matrixWorld.elements[12];
          parkedMatrixWorldZ = parkedEntry.root.matrixWorld.elements[14];
        }
        if (parkedEntry?.wasJolted) sawParkedRocking = true;
        const displacedM = Math.hypot(parked.x - origP.x, parked.z - origP.z);
        // Pause mid-scrape once active sparks, single-wheel skid ribbon, and finite-mass parked breakaway are live!
        if (
          sawScrape &&
          (cd?.activeSparks ?? 0) >= 16 &&
          peakSkidSegments >= 2 &&
          displacedM >= 0.015 &&
          sawParkedRocking &&
          w.player.speed * 3.6 >= 11
        ) {
          break;
        }
        if (w.player.x >= parked.x + 4.0) break;
      }
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", bubbles: true }));
      window.sim.pause(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const finalCd = window.sim.crashDiagnostics();
      // Scraped parked car sits on +Z side (z ~ -106.14), contact patch at z ~ -107.0, player center at z ~ -108.5:
      // Any puff at z < player.z - 0.35 would be an unintended opposite-side (-Z) wheel puff!
      const oppositeSideSmokePuffs = (finalCd?.activeSmokePositions ?? []).filter(
        (p) => (p.kind === "scrape" || p.kind === "tire") && p.z < w.player.z - 0.35,
      ).length;
      return {
        sawScrape,
        peakSparks,
        peakSmoke,
        peakSkidSegments,
        peakSymmetricTireSmoke,
        oppositeSideSmokePuffs,
        activeDriftTireSmokeAtShot: finalCd?.activeDriftTireSmoke ?? 0,
        peakBrakeState,
        sawParkedRocking,
        hudSpeedKmh: Number(document.getElementById("speedVal")?.textContent ?? 0),
        parkedDisplacedM: Number(Math.hypot(parked.x - origP.x, parked.z - origP.z).toFixed(4)),
        parkedSkewDeg: Number((Math.abs(parked.heading - origP.heading) * 180 / Math.PI).toFixed(3)),
        parkedExpectedX: Number(parked.x.toFixed(3)),
        parkedMatrixWorldX: Number(parkedMatrixWorldX.toFixed(3)),
        parkedMatrixWorldZ: Number(parkedMatrixWorldZ.toFixed(3)),
        symmetricTireSmokeDuringScrape: peakSymmetricTireSmoke,
        scraping: lastActiveScraping ?? w.player.vehicle?.interaction?.scraping ?? null,
        crashDiag: finalCd,
      };
    });
  } finally {
    await page.evaluate(() => {
      for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Space"]) {
        window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
      }
    }).catch(() => {});
    await page.keyboard.up("KeyD").catch(() => {});
    await page.keyboard.up("KeyW").catch(() => {});
  }
  await page.screenshot({ path: join(outDir, "wheel-scrape-sparks-and-reaction.png") });
  const scrapeDeltaCheck = await page.evaluate(async () => {
    const grabScrapePatch = () =>
      new Promise((resPatch) => {
        requestAnimationFrame(() => {
          const sceneCanvas = document.querySelector("canvas.scene");
          const off = document.createElement("canvas");
          off.width = 682;
          off.height = 450;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(sceneCanvas, 0, 0, 682, 450);
          resPatch(ctx.getImageData(240, 185, 250, 205).data);
        });
      });
    const meanDiff = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) {
        s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
      }
      return s / (a.length / 4);
    };
    const img = await grabScrapePatch();
    let brightSparkPixels = 0;
    let maxSparkR = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i] > maxSparkR) maxSparkR = img[i];
      if (img[i] >= 205 && img[i + 1] >= 175) brightSparkPixels++;
    }
    const crashGroup = window.sim.view.scene.getObjectByName("crash-effects-layer");
    if (crashGroup) crashGroup.visible = false;
    const noCrashFxImg = await grabScrapePatch();
    if (crashGroup) crashGroup.visible = true;
    await grabScrapePatch();
    return {
      brightSparkPixels,
      maxSparkR,
      scrapeFxPixelDelta: Number(meanDiff(img, noCrashFxImg).toFixed(4)),
    };
  });
  scrapeCheck = { ...scrapeCheck, ...scrapeDeltaCheck };
  await page.evaluate(() => window.sim.pause(false));

  report.wheelScrapeAndVehicleReactionCheck = {
    passed:
      scrapeCheck.sawScrape === true &&
      scrapeCheck.peakSparks >= 8 &&
      scrapeCheck.peakSmoke >= 4 &&
      scrapeCheck.peakSkidSegments >= 2 &&
      scrapeCheck.peakSymmetricTireSmoke === 0 &&
      scrapeCheck.oppositeSideSmokePuffs === 0 &&
      scrapeCheck.activeDriftTireSmokeAtShot === 0 &&
      scrapeCheck.brightSparkPixels >= 2 &&
      scrapeCheck.scrapeFxPixelDelta >= 0.002 &&
      scrapeCheck.hudSpeedKmh >= 10 &&
      scrapeCheck.sawParkedRocking === true &&
      scrapeCheck.parkedDisplacedM >= 0.01 &&
      Math.abs(scrapeCheck.parkedMatrixWorldX - scrapeCheck.parkedExpectedX) < 0.05 &&
      scrapeCheck.peakBrakeState === 0,
    ...scrapeCheck,
  };

  // 5. Live Chromium/WebGL 5-Star Pursuit Frame-Time Distribution & Actual Renderer Draw Calls
  await page.bringToFront().catch(() => {});
  const start5StarPerfRun = async () => {
    await page.evaluate(async () => {
      window.sim.reset({ cityVersion: 5, traffic: 96, pedestrians: 144, seed: "browser-5star-perf" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const btn = document.getElementById("pakoBtn");
      if (btn && btn.getAttribute("aria-expanded") !== "true") btn.click();
      const manualBtn = document.getElementById("pakoDriverManual");
      if (manualBtn) manualBtn.click();
      const levelSel = document.getElementById("pursuitLevel");
      if (levelSel) {
        levelSel.value = "5";
        levelSel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 25));
      const runBtn = document.getElementById("pursuitRunBtn");
      if (runBtn) runBtn.click();
      await new Promise((r) => setTimeout(r, 25));
      if (btn && btn.getAttribute("aria-expanded") === "true") btn.click();
      window.sim.pause(true);
    });
    await page.waitForFunction(
      () => {
        const rd = window.sim?.renderDiagnostics?.();
        return rd?.actors?.ready === true && rd?.actors?.pendingPeople === 0;
      },
      null,
      { timeout: 20000 },
    );
    await page.evaluate(() => window.sim.pause(false));
  };

  // Warm V8 TurboFan JIT & ANGLE D3D11 shader cache across 140 pursuit frames with ALL passes enabled (#driveSense visionCamera + #cameraBtn frontCamera + shadowMap + cinematicPost)
  await start5StarPerfRun();
  await page.evaluate(async () => {
    if (document.getElementById("cameraLabel")?.hidden !== false) {
      document.getElementById("cameraBtn")?.click();
    }
    await new Promise((r) => requestAnimationFrame(r));
  });
  await page.keyboard.down("KeyW");
  await page.evaluate(async () => {
    for (let i = 0; i < 140; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.keyboard.up("KeyW").catch(() => {});

  await start5StarPerfRun();
  await page.keyboard.down("KeyW");
  let browserWebglPerf;
  try {
    browserWebglPerf = await page.evaluate(async () => {
      // Enable frontCamera scissor PiP alongside live #driveSense visionCamera so ALL passes run simultaneously!
      if (document.getElementById("cameraLabel")?.hidden !== false) {
        document.getElementById("cameraBtn")?.click();
      }
      // Verify #driveSense front-RGB decodes advancing frame IDs with detector off while frontCamera PiP is ALSO active
      let dsFirst = 0;
      for (let i = 0; i < 45; i++) {
        const dsImg = document.getElementById("driveSenseImage");
        if (dsImg && !dsImg.hidden && Number(dsImg.dataset.frameId) >= 1) {
          dsFirst = Number(dsImg.dataset.frameId);
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      let dsSecond = dsFirst;
      for (let i = 0; i < 50; i++) {
        const dsImg = document.getElementById("driveSenseImage");
        const fid = Number(dsImg?.dataset?.frameId ?? 0);
        if (dsImg && !dsImg.hidden && fid > dsFirst) {
          dsSecond = fid;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      const dsEmpty = document.getElementById("driveSenseEmpty");
      const driveSensePreviewLive = Boolean(dsFirst >= 1 && dsSecond > dsFirst && dsEmpty?.hidden === true);
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }

      const rdStart = window.sim.renderDiagnostics();
      const startDiscardedS = rdStart?.discardedSimSeconds ?? 0;
      const startShadowPasses = rdStart?.shadowPassFrames ?? 0;
      const startVisionPasses = rdStart?.visionCaptureFrames ?? 0;
      const startFrontPreviewPasses = rdStart?.frontPreviewFrames ?? 0;
      const startTick = window.sim.world.tick;

      const frameDeltasMs = [];
      const frameWorkMs = [];
      let minMainDrawCalls = Infinity;
      let peakMainDrawCalls = 0;
      let peakTotalRenderCalls = 0;
      const lastTs0 = await new Promise((r) => requestAnimationFrame(r));
      let lastTs = lastTs0;
      for (let i = 0; i < 120; i++) {
        const nowTs = await new Promise((r) => requestAnimationFrame(r));
        frameDeltasMs.push(nowTs - lastTs);
        lastTs = nowTs;
        const rd = window.sim.renderDiagnostics();
        if (Number.isFinite(rd?.lastFrameWorkMs)) frameWorkMs.push(rd.lastFrameWorkMs);
        if ((rd?.mainCalls ?? 0) > 0 && rd.mainCalls < minMainDrawCalls) minMainDrawCalls = rd.mainCalls;
        if ((rd?.mainCalls ?? 0) > peakMainDrawCalls) peakMainDrawCalls = rd.mainCalls;
        if ((rd?.renderCalls ?? 0) > peakTotalRenderCalls) peakTotalRenderCalls = rd.renderCalls;
      }
      const endTick = window.sim.world.tick;
      const rdFinal = window.sim.renderDiagnostics();
      const endDiscardedS = rdFinal?.discardedSimSeconds ?? 0;
      const shadowPassesInSample = (rdFinal?.shadowPassFrames ?? 0) - startShadowPasses;
      const visionPassesInSample = (rdFinal?.visionCaptureFrames ?? 0) - startVisionPasses;
      const frontPreviewPassesInSample = (rdFinal?.frontPreviewFrames ?? 0) - startFrontPreviewPasses;
      const wallElapsedS = Math.max(0.001, (lastTs - lastTs0) / 1000);
      const simTicksElapsed = endTick - startTick;
      const simTickHz = simTicksElapsed / wallElapsedS;
      const discardedSimSecondsDelta = Number((endDiscardedS - startDiscardedS).toFixed(6));
      const sorted = [...frameDeltasMs].sort((a, b) => a - b);
      const sortedWork = [...frameWorkMs].sort((a, b) => a - b);
      const avgFrameMs = frameDeltasMs.reduce((s, v) => s + v, 0) / frameDeltasMs.length;
      const p50FrameMs = sorted[Math.floor(sorted.length * 0.5)];
      const p95FrameMs = sorted[Math.floor(sorted.length * 0.95)];
      const avgFrameWorkMs = sortedWork.length
        ? frameWorkMs.reduce((s, v) => s + v, 0) / frameWorkMs.length
        : avgFrameMs;
      const p50FrameWorkMs = sortedWork.length
        ? sortedWork[Math.floor(sortedWork.length * 0.5)]
        : p50FrameMs;
      const p95FrameWorkMs = sortedWork.length
        ? sortedWork[Math.floor(sortedWork.length * 0.95)]
        : p95FrameMs;
      const surfDiag = window.sim.streetSurfaceDiagnostics();
      const actors = window.sim.world.actors;
      const pedestrianCount = actors.filter((a) => a.type === "pedestrian").length;
      const patrolCount = window.sim.world.pursuit?.patrols?.size ?? 0;
      const trafficCount = actors.filter((a) => a !== window.sim.world.player && a.type !== "pedestrian" && a.pursuitRole !== "police").length;
      return {
        framesSampled: frameDeltasMs.length,
        activeActors: actors.length,
        trafficCount,
        pedestrianCount,
        wantedLevel: window.sim.world.pursuit?.wantedLevel ?? window.sim.world.pursuit?.gta?.wantedLevel ?? 0,
        activePatrols: patrolCount,
        rendererAutoReset: rdFinal?.autoReset,
        driveSensePreviewLive,
        driveSenseFirstFrameId: dsFirst,
        driveSenseSecondFrameId: dsSecond,
        previewActiveDuringSample: Boolean(rdFinal?.previewActive),
        cameraScreenActiveDuringSample: Boolean(rdFinal?.cameraScreenVisible),
        shadowPassesInSample,
        visionPassesInSample,
        frontPreviewPassesInSample,
        simTicksElapsed,
        wallElapsedS: Number(wallElapsedS.toFixed(3)),
        simTickHz: Number(simTickHz.toFixed(2)),
        discardedSimSecondsDelta,
        avgFrameWorkMs: Number(avgFrameWorkMs.toFixed(3)),
        p50FrameWorkMs: Number(p50FrameWorkMs.toFixed(3)),
        p95FrameWorkMs: Number(p95FrameWorkMs.toFixed(3)),
        avgFrameMs: Number(avgFrameMs.toFixed(3)),
        p50FrameMs: Number(p50FrameMs.toFixed(3)),
        p95FrameMs: Number(p95FrameMs.toFixed(3)),
        equivalentAvgFps: Number((1000 / Math.max(0.1, avgFrameMs)).toFixed(1)),
        equivalentWorkAvgFps: Number((1000 / Math.max(0.1, avgFrameWorkMs)).toFixed(1)),
        equivalentWorkMedianFps: Number((1000 / Math.max(0.1, p50FrameWorkMs)).toFixed(1)),
        webglColorPassDrawCalls: Number.isFinite(minMainDrawCalls) ? minMainDrawCalls : peakMainDrawCalls,
        webglMainPassDrawCalls: rdFinal?.mainCalls ?? peakMainDrawCalls,
        peakWebglWithShadowDrawCalls: peakMainDrawCalls,
        peakWebglTotalRenderCalls: peakTotalRenderCalls,
        webglMainTriangles: rdFinal?.mainTriangles ?? 0,
        streetSurfaceLayerDrawCalls: surfDiag?.drawCalls ?? 0,
        webglRenderer: rdFinal?.graphicsAdapter ?? rdFinal?.renderer ?? "unknown",
      };
    });
  } finally {
    await page.keyboard.up("KeyW").catch(() => {});
  }

  report.browserWebgl5StarPerfCheck = {
    passed:
      browserWebglPerf.rendererAutoReset === false &&
      browserWebglPerf.wantedLevel === 5 &&
      browserWebglPerf.trafficCount === 96 &&
      browserWebglPerf.pedestrianCount === 144 &&
      browserWebglPerf.activePatrols >= 10 &&
      browserWebglPerf.driveSensePreviewLive === true &&
      browserWebglPerf.previewActiveDuringSample === true &&
      browserWebglPerf.frontPreviewPassesInSample >= 120 &&
      browserWebglPerf.visionPassesInSample >= 4 &&
      browserWebglPerf.shadowPassesInSample >= 8 &&
      browserWebglPerf.discardedSimSecondsDelta === 0 &&
      browserWebglPerf.simTickHz >= 55 &&
      browserWebglPerf.simTickHz <= 65 &&
      browserWebglPerf.avgFrameMs <= 16.67 &&
      browserWebglPerf.p50FrameMs <= 16.67 &&
      browserWebglPerf.avgFrameWorkMs <= 16.67 &&
      browserWebglPerf.p50FrameWorkMs <= 16.67 &&
      browserWebglPerf.streetSurfaceLayerDrawCalls <= 18 &&
      browserWebglPerf.webglColorPassDrawCalls <= 500 &&
      browserWebglPerf.peakWebglWithShadowDrawCalls <= 500 &&
      browserWebglPerf.peakWebglTotalRenderCalls <= 500,
    ...browserWebglPerf,
  };

  report.passed =
    report.errors.length === 0 &&
    report.unforcedDefaultSpawnJourneyCheck.passed &&
    report.fresnelWaterRipplesAndWetTracksCheck.passed &&
    report.sandRutsAndDustCloudCheck.passed &&
    report.volumetricSmokeAndSkidsCheck.passed &&
    report.wheelScrapeAndVehicleReactionCheck.passed &&
    report.browserWebgl5StarPerfCheck.passed;
} finally {
  writeFileSync(join(outDir, "interaction-browser.json"), JSON.stringify(report, null, 2));
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
    waterLuma: report.fresnelWaterRipplesAndWetTracksCheck?.puddleMeanLuma,
    wetTracks: report.fresnelWaterRipplesAndWetTracksCheck?.peakWetTracks,
    sandRuts: report.sandRutsAndDustCloudCheck?.peakRuts,
    dustDelta: report.sandRutsAndDustCloudCheck?.dustPlumePixelDelta,
    smokePuffs: report.volumetricSmokeAndSkidsCheck?.peakSmoke,
    scrapeSparks: report.wheelScrapeAndVehicleReactionCheck?.peakSparks,
    parkedWorldX: report.wheelScrapeAndVehicleReactionCheck?.parkedMatrixWorldX,
  }),
);
assert.equal(report.passed, true, `Headed interaction browser check failed: ${JSON.stringify(report.errors)}`);
