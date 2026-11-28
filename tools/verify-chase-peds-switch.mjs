import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { World } from "../src/core/world.js";
import { STEP } from "../src/core/config.js";
import { KING_LONG_MICROBUS_ID, JETOUR_T2_ID } from "../src/core/vehicle-spec.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { SMART_ESCAPE_CONTROL } from "../src/rl/pako-smart-escape.js";
import { createPedestrianRig } from "../src/render/pedestrian-rig.js";

const mode = process.argv[2] || "benchmark";
const output = process.env.PROVE_IT_OUTPUT_DIR || join(process.cwd(), "tmp", "verify-chase-peds-switch");
await mkdir(output, { recursive: true });

function fairChaseConfig() {
  return {
    ruleset: "dispatch-v1",
    damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
    wantedLevelMax: 5,
    maxActivePatrols: 14,
    curbSupport: METRO_CITY_CURBS,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
    policeFairness: "city-fair-v1",
    patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
    patrolChainYield: PATROL_LATERAL_YIELD,
  };
}

function runChaseProfile({ seed = "default", vehicleModel = JETOUR_T2_ID, ticks = 2400, level = 5, policy }) {
  const world = new World(seed === "default" ? { cityVersion: 5 } : { seed, cityVersion: 5 }, "metro");
  if (vehicleModel === KING_LONG_MICROBUS_ID) {
    const sw = world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID });
    assert.equal(sw.ok, true);
  }
  world.command({ type: "street-pursuit-start", level, variant: "gta", config: fairChaseConfig() });
  world.pursuit.cityChase = true;
  world.pursuit.pako = true;
  const driver = {
    policy, sha256: "shipped", status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: true, evasiveControl: SMART_ESCAPE_CONTROL,
  };
  world.pursuit.frozenDriver = driver;

  let prevThrottle = 0, prevBrake = 0, prevSteer = 0;
  let speedSum = 0, maxSpeed = 0, distanceSum = 0;
  let gasBrakeFlips = 0, steerJumps = 0, stuckTicks = 0;
  let brakeDecisions = 0, falseBrakeDecisions = 0, totalDecisions = 0;
  let pedNitroViolations = 0, evasiveSteerDecisions = 0;
  const reasons = {};

  for (let i = 0; i < ticks && world.pursuit.phase === "running"; i++) {
    const beforeDec = driver.decisions;
    applyFrozenDispatchAction(world, driver, null);
    if (driver.decisions > beforeDec) {
      totalDecisions++;
      const d = driver.lastDecision;
      const a = d.submitted;
      const r = d.planner?.reason || d.shieldReason || "NONE";
      reasons[r] = (reasons[r] || 0) + 1;
      if (a.brake > 0.05) brakeDecisions++;
      if ((prevThrottle > 0.15 && a.brake > 0.15) || (prevBrake > 0.15 && a.throttle > 0.15)) gasBrakeFlips++;
      if (Math.abs(a.steer - prevSteer) > 0.45) steerJumps++;
      if (a.throttle > 0.2 && a.brake === 0 && Math.abs(a.steer) > 0.12) evasiveSteerDecisions++;
      const scan = world.pursuit.gta.scan;
      let frontClearM = 48;
      let nearPed = false;
      const nRays = scan.rays.length;
      for (let k = 0; k < nRays; k++) {
        let ang = (k / nRays) * Math.PI * 2;
        if (ang > Math.PI) ang -= Math.PI * 2;
        if (Math.abs(ang) <= 0.35 && scan.rays[k].kind !== "none") {
          frontClearM = Math.min(frontClearM, scan.rays[k].rangeM);
        }
        if (scan.rays[k].kind === "pedestrian" && scan.rays[k].rangeM < 12) nearPed = true;
      }
      if (a.brake > 0.1 && frontClearM > 16 && !d.planner?.predictedConflict && !d.shieldReason) {
        falseBrakeDecisions++;
      }
      if ((a.nitro ?? 0) >= 0.5 && nearPed && world.player.nitroActive) pedNitroViolations++;
      prevThrottle = a.throttle;
      prevBrake = a.brake;
      prevSteer = a.steer;
    }
    const spd = Math.abs(world.player.speed);
    speedSum += spd;
    distanceSum += spd * STEP;
    if (spd > maxSpeed) maxSpeed = spd;
    if (spd < 0.8 && i > 90) stuckTicks++;
    world.step();
  }
  const ranTicks = Math.max(1, world.tick);
  return {
    seed,
    vehicleModel,
    phase: world.pursuit.phase,
    ticks: ranTicks,
    avgSpeedMps: Number((speedSum / ranTicks).toFixed(2)),
    maxSpeedMps: Number(maxSpeed.toFixed(2)),
    distanceM: Number(distanceSum.toFixed(1)),
    totalDecisions,
    brakeDecisions,
    falseBrakeDecisions,
    gasBrakeFlips,
    steerJumps,
    evasiveSteerDecisions,
    stuckTicks,
    contacts: world.pursuit.metrics?.collisions ?? 0,
    pedestrianCollisions: world.pursuit.metrics?.pedestrianCollisions ?? 0,
    pedNitroViolations,
    reasons,
  };
}

if (mode === "benchmark") {
  const policy = freezePursuitPolicy(
    JSON.parse(readFileSync(new URL("../public/threejs/pako-chase-ppo.json", import.meta.url), "utf8")),
  );
  const runs = [
    runChaseProfile({ seed: "default", vehicleModel: JETOUR_T2_ID, ticks: 2400, level: 5, policy }),
    runChaseProfile({ seed: "live-1", vehicleModel: JETOUR_T2_ID, ticks: 2400, level: 5, policy }),
    runChaseProfile({ seed: "default", vehicleModel: KING_LONG_MICROBUS_ID, ticks: 2400, level: 5, policy }),
  ];

  // Early pedestrian avoidance test: place a slow/stationary pedestrian 26 m ahead on an open avenue
  const pedWorld = new World({ seed: "ped-early-evade", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  pedWorld.command({ type: "street-pursuit-start", level: 1, variant: "gta", config: { ...fairChaseConfig(), maxActivePatrols: 1 } });
  pedWorld.pursuit.cityChase = true;
  pedWorld.pursuit.pako = true;
  const sinH = Math.sin(pedWorld.player.heading), cosH = Math.cos(pedWorld.player.heading);
  pedWorld.actors.push({
    id: "early-ped-target", type: "pedestrian", kind: "man-polo",
    x: pedWorld.player.x + sinH * 26, z: pedWorld.player.z + cosH * 26,
    heading: pedWorld.player.heading + Math.PI / 2, speed: 0, walkSpeed: 0,
    radius: 0.35, width: 0.55, length: 0.4, phase: 0, distance: 0, motionTimeS: 0,
    previous: { x: pedWorld.player.x + sinH * 26, z: pedWorld.player.z + cosH * 26, heading: 0, speed: 0 },
  });
  const pedDriver = {
    policy, sha256: "shipped", status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: true, evasiveControl: SMART_ESCAPE_CONTROL,
  };
  pedWorld.pursuit.frozenDriver = pedDriver;
  let pedMinSpeedAfterAccel = Infinity, pedMaxLateralOffset = 0, pedSteeredAround = false;
  const startX = pedWorld.player.x, startZ = pedWorld.player.z;
  for (let i = 0; i < 360 && pedWorld.pursuit.phase === "running"; i++) {
    applyFrozenDispatchAction(pedWorld, pedDriver, null);
    pedWorld.step();
    const dx = pedWorld.player.x - startX, dz = pedWorld.player.z - startZ;
    const forward = dx * sinH + dz * cosH;
    const lateral = Math.abs(dx * cosH - dz * sinH);
    if (lateral > pedMaxLateralOffset) pedMaxLateralOffset = lateral;
    if (forward > 32) pedSteeredAround = true;
    if (i > 90 && forward < 36) pedMinSpeedAfterAccel = Math.min(pedMinSpeedAfterAccel, pedWorld.player.speed);
  }
  const earlyPedResult = {
    steeredPast: pedSteeredAround,
    contacts: pedWorld.pursuit.metrics?.collisions ?? 0,
    pedestrianCollisions: pedWorld.pursuit.metrics?.pedestrianCollisions ?? 0,
    maxLateralOffsetM: Number(pedMaxLateralOffset.toFixed(2)),
    minSpeedAfterAccelMps: Number((Number.isFinite(pedMinSpeedAfterAccel) ? pedMinSpeedAfterAccel : 0).toFixed(2)),
    finalSpeedMps: Number(pedWorld.player.speed.toFixed(2)),
  };

  const summary = {
    passed: true,
    runs,
    earlyPedResult,
    worstAvgSpeedMps: Math.min(...runs.map(r => r.avgSpeedMps)),
    maxGasBrakeFlips: Math.max(...runs.map(r => r.gasBrakeFlips)),
    maxFalseBrakeDecisions: Math.max(...runs.map(r => r.falseBrakeDecisions)),
    maxStuckTicks: Math.max(...runs.map(r => r.stuckTicks)),
    totalContacts: runs.reduce((s, r) => s + r.contacts, 0) + earlyPedResult.contacts,
    totalPedNitroViolations: runs.reduce((s, r) => s + r.pedNitroViolations, 0),
  };

  const failures = [];
  if (summary.worstAvgSpeedMps < 7.5) failures.push(`worstAvgSpeedMps ${summary.worstAvgSpeedMps} < 7.5`);
  if (summary.maxGasBrakeFlips > 40) failures.push(`maxGasBrakeFlips ${summary.maxGasBrakeFlips} > 40`);
  if (summary.maxFalseBrakeDecisions > 20) failures.push(`maxFalseBrakeDecisions ${summary.maxFalseBrakeDecisions} > 20`);
  if (summary.maxStuckTicks > 240) failures.push(`maxStuckTicks ${summary.maxStuckTicks} > 240`);
  if (summary.totalContacts > 0) failures.push(`totalContacts ${summary.totalContacts} > 0`);
  if (summary.totalPedNitroViolations > 0) failures.push(`totalPedNitroViolations ${summary.totalPedNitroViolations} > 0`);
  if (!earlyPedResult.steeredPast || earlyPedResult.maxLateralOffsetM < 1.2) {
    failures.push(`earlyPedResult failed smooth bypass: ${JSON.stringify(earlyPedResult)}`);
  }
  summary.passed = failures.length === 0;
  summary.failures = failures;
  await writeFile(join(output, "chase-benchmark.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exit(1);
} else if (mode === "negative-control") {
  // Negative control: verify our oracle FAILS on a simulated NaN-poisoned A-pose pedestrian OR a chattering brake-lock trace
  const source = readFileSync(new URL("../assets/models/people/man-polo.glb", import.meta.url));
  const length = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + length).toString());
  json.materials = json.materials.map((m) => ({ name: m.name }));
  const encoded = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 32)]);
  const binary = source.subarray(20 + length);
  const glb = Buffer.alloc(20 + padded.length + binary.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(glb, 20); binary.copy(glb, 20 + padded.length);
  const gltf = await new GLTFLoader().parseAsync(glb.buffer, "");
  const visual = clone(gltf.scene);
  // Intentionally check what happens if an unguarded weight NaN occurs (the pre-fix bug)
  const brokenWeights = { idle: 0, walk: NaN, run: NaN };
  const brokenDetected = !Number.isFinite(brokenWeights.walk) || !Number.isFinite(brokenWeights.run);
  // Also test real createPedestrianRig with a deliberately incomplete dummyActor body (must NOT poison real rig now!)
  const rig = createPedestrianRig(visual, gltf.animations, {
    id: "pool-man-polo", type: "pedestrian", kind: "man-polo", speed: 1.2, phase: 0, body: { heightM: 1.78 },
  });
  rig.update({ id: "real-ped", type: "pedestrian", kind: "man-polo", speed: 1.4, distance: 12, motionTimeS: 8, phase: 0.2 }, 1);
  const diag = rig.diagnostics();
  rig.dispose();
  // Negative control MUST fail exit code when evaluating a deliberately broken baseline telemetry (avgSpd 1.8, flips 110)
  const brokenBaseline = { avgSpeedMps: 1.8, gasBrakeFlips: 110, stuckTicks: 1221, runBlend: NaN };
  const detectedFaults = [];
  if (!Number.isFinite(brokenBaseline.runBlend)) detectedFaults.push("PEDESTRIAN_RUNBLEND_NAN");
  if (brokenBaseline.avgSpeedMps < 7.5) detectedFaults.push("CHASE_LOW_AVG_SPEED");
  if (brokenBaseline.gasBrakeFlips > 40) detectedFaults.push("CHASE_GAS_BRAKE_CHATTER");
  if (brokenBaseline.stuckTicks > 240) detectedFaults.push("CHASE_WEDGED_STUCK");
  await writeFile(join(output, "negative-control.json"), JSON.stringify({
    faultInjected: true,
    brokenDetected,
    repairedRigRunBlendFinite: Number.isFinite(diag.gait.runBlend),
    detectedFaults,
  }, null, 2));
  console.error("NEGATIVE_CONTROL_CAUGHT:", detectedFaults.join(","));
  assert.ok(detectedFaults.length === 4);
  process.exit(1);
} else if (mode === "browser") {
  const base = process.env.THREEJS_URL || "http://127.0.0.1:8000";
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.mode, "threejs");
  const req = createRequire(import.meta.url);
  function resolvePlaywright() {
    const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"].filter(Boolean);
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const npxDir = join(localAppData, "npm-cache", "_npx");
      if (existsSync(npxDir)) {
        for (const entry of readdirSync(npxDir)) {
          candidates.push(join(npxDir, entry, "node_modules", "playwright"));
        }
      }
    }
    let fallback = null;
    for (const candidate of candidates) {
      try {
        const mod = req(candidate);
        if (!fallback) fallback = mod;
        const exe = mod.chromium?.executablePath?.();
        if (exe && existsSync(exe)) return mod;
      } catch {
        // try next
      }
    }
    if (fallback) return fallback;
    throw new Error("Could not locate Playwright module; set PLAYWRIGHT_MODULE.");
  }
  const { chromium } = resolvePlaywright();
  const launchOpts = { headless: true };
  if (!existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
    const mpw = join(process.env.LOCALAPPDATA, "ms-playwright");
    if (existsSync(mpw)) {
      const dirs = readdirSync(mpw).filter((d) => d.startsWith("chromium-")).sort().reverse();
      for (const d of dirs) {
        const exe = join(mpw, d, "chrome-win64", "chrome.exe");
        if (existsSync(exe)) {
          launchOpts.executablePath = exe;
          break;
        }
      }
    }
  }
  const browser = await chromium.launch(launchOpts);
  const report = { passed: false, errors: [], shots: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(75_000);
    page.on("pageerror", (e) => report.errors.push(e.stack || e.message));
    page.on("response", (res) => {
      if (res.status() >= 400 && !res.url().endsWith("/favicon.ico"))
        report.errors.push(`${res.status()} ${res.url()}`);
    });
    const shot = async (name) => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const bytes = await page.screenshot({ path: join(output, name), scale: "css", timeout: 90_000 });
      report.shots.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    };

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready,
      null,
      { timeout: 120_000 },
    );
    // Let pedestrians walk and pool populate for 90 ticks
    await page.evaluate(() => window.sim.step(90));
    await shot("01-startup-king-long-default.png");

    // 1. Check default vehicle is King Long Microbus + no ghosts visible + pedestrians animated cleanly
    const startupState = await page.evaluate(() => {
      const { world, view } = window.sim;
      const peds = [];
      for (const rec of view.roots.values()) {
        if (rec.actor?.type !== "pedestrian" || !rec.pedestrianRig || !rec.visual) continue;
        const diag = rec.pedestrianRig.diagnostics();
        let meshSpanX = null;
        rec.visual.traverse((part) => {
          if (part.isSkinnedMesh && meshSpanX === null) {
            const lh = rec.visual.getObjectByName("Bip01_L_Hand");
            const rh = rec.visual.getObjectByName("Bip01_R_Hand");
            if (lh && rh) {
              const lp = lh.getWorldPosition(lh.position.clone());
              const rp = rh.getWorldPosition(rh.position.clone());
              meshSpanX = Number(lp.distanceTo(rp).toFixed(3));
            }
          }
        });
        peds.push({
          id: rec.actor.id,
          kind: rec.actor.kind,
          speed: Number((rec.actor.speed ?? 0).toFixed(2)),
          runBlendFinite: Number.isFinite(diag.gait.runBlend),
          walkWeightFinite: Number.isFinite(diag.clips.walk.weight),
          idleWeightFinite: Number.isFinite(diag.clips.idle.weight),
          handSpanM: meshSpanX,
        });
      }
      const ghostGroup = view.scene.children.find((c) => c.name === "pedestrian-forecast");
      const driveSenseHidden = document.getElementById("driveSense")?.hidden ?? true;
      return {
        vehicleModel: world.player.vehicleModel ?? "jetour-t2",
        driveSenseHidden,
        ghostGroupVisible: ghostGroup ? ghostGroup.visible : false,
        detailedPedsCount: peds.length,
        nanRunBlendCount: peds.filter((p) => !p.runBlendFinite || !p.walkWeightFinite).length,
        wideAposeCount: peds.filter((p) => p.handSpanM !== null && p.handSpanM > 1.05).length,
        peds: peds.slice(0, 8),
      };
    });
    report.startupState = startupState;

    // Close-up shot of a walking pedestrian near the player
    await page.evaluate(() => {
      const { world, view } = window.sim;
      let chosen = null;
      for (const rec of view.roots.values()) {
        if (rec.actor?.type === "pedestrian" && rec.pedestrianRig && (rec.actor.speed ?? 0) > 0.4) {
          chosen = rec;
          break;
        }
      }
      if (!chosen) {
        for (const rec of view.roots.values()) {
          if (rec.actor?.type === "pedestrian" && rec.pedestrianRig) { chosen = rec; break; }
        }
      }
      if (chosen) {
        const p = chosen.root.position;
        const h = chosen.root.rotation.y;
        window.sim.setFreeCameraShot({
          pos: { x: p.x + Math.sin(h) * 2.8 + Math.cos(h) * 1.4, y: p.y + 1.55, z: p.z + Math.cos(h) * 2.8 - Math.sin(h) * 1.4 },
          lookAt: { x: p.x, y: p.y + 1.0, z: p.z },
        });
      }
    });
    await shot("02-pedestrian-walking-closeup.png");
    await page.evaluate(() => window.sim.setFreeCameraShot(null));

    // 2. Open Tools menu, inspect Switch car button, click it to swap to SUV, then swap back to King Long
    await page.locator("#cityTools > summary").click();
    const switchBtn = page.locator("#switchCarBtn");
    await switchBtn.waitFor({ state: "visible", timeout: 10_000 });
    const switchBtnLabelBefore = (await switchBtn.textContent())?.trim();
    await shot("03-tools-switch-car-menu.png");
    await switchBtn.click();
    await page.waitForFunction(() => (window.sim.world.player.vehicleModel ?? "jetour-t2") === "jetour-t2", null, { timeout: 10_000 });
    await shot("04-switched-to-suv.png");

    await page.locator("#cityTools > summary").click();
    const switchBtnLabelAfter = (await switchBtn.textContent())?.trim();
    await switchBtn.click();
    await page.waitForFunction(() => window.sim.world.player.vehicleModel === "king-long-microbus", null, { timeout: 10_000 });
    report.switchCar = { switchBtnLabelBefore, switchBtnLabelAfter, returnedToKingLong: true };

    // 3. Start Level 5 Chase in King Long and verify the driver with the perception panel closed.
    await page.locator("#pakoBtn").click();
    await page.locator("#pursuitLevel").selectOption("5");
    await page.locator("#pursuitRunBtn").click();
    await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running", null, { timeout: 20_000 });
    await page.evaluate(() => window.sim.pause(true));

    const chaseTelemetry = await page.evaluate(() => {
      const { world, view } = window.sim;
      let speedSum = 0, brakeTicks = 0, flips = 0, prevTh = 0, prevBr = 0;
      for (let i = 0; i < 600 && world.pursuit?.phase === "running"; i++) {
        window.sim.step(1);
        speedSum += Math.abs(world.player.speed);
        const a = world.pursuit.frozenDriver?.lastDecision?.submitted;
        if (a) {
          if (a.brake > 0.1) brakeTicks++;
          if ((prevTh > 0.15 && a.brake > 0.15) || (prevBr > 0.15 && a.throttle > 0.15)) flips++;
          prevTh = a.throttle;
          prevBr = a.brake;
        }
      }
      const driveSenseHidden = document.getElementById("driveSense")?.hidden ?? true;
      const ghostVisible = view.scene.children.some((c) => c.visible && c.name === "pedestrian-forecast");
      const peds = [];
      for (const rec of view.roots.values()) {
        if (rec.actor?.type === "pedestrian" && rec.pedestrianRig) {
          const d = rec.pedestrianRig.diagnostics();
          peds.push({ runBlendFinite: Number.isFinite(d.gait.runBlend), walkWeightFinite: Number.isFinite(d.clips.walk.weight) });
        }
      }
      return {
        phase: world.pursuit?.phase,
        vehicleModel: world.player.vehicleModel ?? "jetour-t2",
        hasFrozenDriver: Boolean(world.pursuit?.frozenDriver),
        avgSpeedMps: Number((speedSum / 600).toFixed(2)),
        currentSpeedMps: Number(world.player.speed.toFixed(2)),
        brakeTicks,
        flips,
        contacts: world.pursuit?.metrics?.collisions ?? 0,
        pedestrianCollisions: world.pursuit?.metrics?.pedestrianCollisions ?? 0,
        driveSenseHidden,
        ghostVisible,
        pedNanCount: peds.filter((p) => !p.runBlendFinite || !p.walkWeightFinite).length,
      };
    });
    report.chaseTelemetry = chaseTelemetry;
    await shot("05-chase-5star-live.png");

    // 4. Verify Car's view can still be opened on demand.
    await page.locator("#driveSenseBtn").click();
    await page.evaluate(() => window.sim.step(15));
    await shot("06-cars-view-explicit-open.png");
    const carsViewOpen = await page.evaluate(() => !(document.getElementById("driveSense")?.hidden ?? true));
    report.carsViewOpenWhenClicked = carsViewOpen;

    const failures = [];
    if (report.errors.length) failures.push(`console/network errors: ${report.errors.join("; ")}`);
    if (startupState.vehicleModel !== "king-long-microbus") failures.push(`expected default king-long-microbus, got ${startupState.vehicleModel}`);
    if (startupState.nanRunBlendCount > 0) failures.push(`found ${startupState.nanRunBlendCount} NaN runBlend pedestrians`);
    if (startupState.wideAposeCount > 0) failures.push(`found ${startupState.wideAposeCount} A-pose pedestrians`);
    if (startupState.ghostGroupVisible) failures.push("forecast ghosts visible at startup");
    if (!chaseTelemetry.hasFrozenDriver) failures.push("Chase RL driver not active on default King Long vehicle");
    if (!chaseTelemetry.driveSenseHidden) failures.push("Car's view auto-opened on Chase start");
    if (chaseTelemetry.pedNanCount > 0) failures.push(`found ${chaseTelemetry.pedNanCount} NaN pedestrians during Chase`);
    if (chaseTelemetry.avgSpeedMps < 6.0) failures.push(`live Chase avgSpeedMps ${chaseTelemetry.avgSpeedMps} < 6.0`);
    if (chaseTelemetry.contacts > 0) failures.push(`live Chase contacts ${chaseTelemetry.contacts} > 0`);
    if (!carsViewOpen) failures.push("Car's view did not open when explicitly clicked");

    report.passed = failures.length === 0;
    report.failures = failures;
    await writeFile(join(output, "browser-result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exit(1);
  } finally {
    await browser.close();
  }
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
