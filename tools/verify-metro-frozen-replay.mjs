import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(join(process.cwd(), "package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url } = process.env;
const path = fileURLToPath(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const sha256 = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const seed = "city-route-dev-eval-00";
assert.equal(digest(await readFile(path)), sha256);

const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const report = { engine: browser.version(), classification: "development live chase and same-engine replay", errors: [] };
const contextOptions = { viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 };
const snapshot = page => page.evaluate(() => window.sim.snapshot());

async function openPaused(context) {
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
  page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
  await page.bringToFront();
  await page.locator("#pauseBtn").click();
  await page.waitForFunction(() => window.sim.paused);
  await clickCityTool(page, "settingsBtn");
  return page;
}

async function importReplay(page, data, name, status = "Replay restored from recorded commands.") {
  const before = await page.evaluateHandle(() => window.sim.world);
  const progress = page.locator("#replayProgress");
  const started = performance.now();
  try {
    await page.locator("#replayFile").setInputFiles({ name, mimeType: "application/json", buffer: data });
    await page.waitForFunction(() => document.getElementById("replayFile").files.length === 0 &&
      /^(Replay restored|Could not load replay)/.test(document.getElementById("replayProgress").textContent),
    null, { timeout: 130_000, polling: 250 });
    assert.equal(await progress.textContent(), status);
    assert.equal(await page.evaluate(before => window.sim.world !== before, before),
      status === "Replay restored from recorded commands.");
    assert.equal(await page.evaluate(() => window.sim.paused), true);
  } finally {
    (report.imports ??= []).push({ name, wallSeconds: (performance.now() - started) / 1000,
      progress: await progress.textContent({ timeout: 2000 }).catch(error => error.message) });
    await before.dispose();
  }
}

async function observeLiveTiming(page) {
  await page.evaluate(() => {
    const sim = window.sim, { world, view } = sim;
    const ambient = world.actors.filter(actor => actor !== world.player && !actor.pursuitRole);
    const measurements = { intervals: [], ticksMs: [], syncMs: [], prepareMs: [], inferenceMs: [], bins: [] };
    const restorers = [];
    for (const [object, method, samples] of [[world, "step", measurements.ticksMs],
      [view, "sync", measurements.syncMs], [view, "prepareFrame", measurements.prepareMs]]) {
      const original = object[method];
      object[method] = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally {
          if (world.pursuit?.phase === "running") samples.push(performance.now() - start);
        }
      };
      restorers.push(() => { delete object[method]; });
    }

    let bin, priorTime, priorDecisions;
    function sample(time) {
      const run = world.pursuit;
      if (!run) return requestAnimationFrame(sample);
      if (run.phase !== "running") {
        restorers.forEach(restore => restore());
        window.__metroTiming = measurements;
        return;
      }
      const { decisions, inferenceMs } = run.frozenDriver;
      if (decisions && decisions !== priorDecisions) {
        measurements.inferenceMs.push(inferenceMs);
        priorDecisions = decisions;
      }
      if (priorTime !== undefined) measurements.intervals.push(time - priorTime);
      priorTime = time;
      if (!bin || time - bin.time >= 1000) {
        const d = sim.renderDiagnostics();
        if (bin) {
          const wallS = (time - bin.time) / 1000;
          const actors = new Set(world.actors);
          measurements.bins.push({ wallS, renderedFPS: (d.renderedFrames - bin.frames) / wallS,
            tickHz: (world.tick - bin.tick) / wallS, tick: world.tick,
            discardedSimSeconds: d.discardedSimSeconds - bin.discarded,
            distanceM: run.metrics.distanceM, focus: document.hasFocus(), visibility: document.visibilityState,
            traffic: world.actors.filter(a => a.type === "vehicle" && !a.pursuitRole && a !== world.player).length,
            pedestrians: world.actors.filter(a => a.type === "pedestrian").length,
            activePatrols: [...run.patrols].filter(unit => unit.aiState !== "WRECKED").length,
            retained: ambient.every(actor => actors.has(actor)),
            mainCalls: d.mainCalls, mainTriangles: d.mainTriangles, heapBytes: performance.memory?.usedJSHeapSize ?? null });
        }
        measurements.graphics ??= { width: d.width, height: d.height, pixelRatio: d.pixelRatio,
          backend: d.backend, adapter: d.graphicsAdapter };
        bin = { time, tick: world.tick, frames: d.renderedFrames, discarded: d.discardedSimSeconds };
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}

try {
  const original = await browser.newContext(contextOptions);
  const page = await openPaused(original);
  const form = page.locator("#settingsForm");
  await form.locator('[name="seed"]').fill(seed);
  await form.locator('[name="traffic"]').press("End");
  await form.locator('[name="pedestrians"]').press("End");
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(seed => window.sim.world.config.seed === seed &&
    window.sim.world.capacity.traffic === 96 && window.sim.world.capacity.pedestrians === 144, seed);
  if (await page.locator("#closeSettings").isVisible()) await page.locator("#closeSettings").click();
  if (!await page.locator("#pursuitStyle").isVisible()) await clickCityTool(page, "streetPursuitBtn");
  await page.locator("#pursuitStyle").selectOption("dispatch-ppo");
  await page.locator("#pursuitLevel").selectOption("5");
  assert.equal(await page.locator("#pursuitRunBtn").isDisabled(), true);
  await page.locator("#pursuitCheckpoint").setInputFiles(path);
  await page.getByText(new RegExp(`SHA-256 ${sha256.slice(0, 12)}`)).waitFor();
  await observeLiveTiming(page);
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => {
    const run = window.sim.world.pursuit;
    return run && run.phase !== "running";
  }, null, { timeout: 190_000, polling: 250 });
  await page.waitForFunction(() => window.__metroTiming !== undefined);
  const timing = await page.evaluate(() => window.__metroTiming);
  const percentiles = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
    return { count: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
  };
  assert.ok(timing.bins.length >= 30 && timing.bins.every(row => row.retained && row.traffic === 96 && row.pedestrians === 144));
  assert.ok(timing.inferenceMs.length > 100 && timing.inferenceMs.every(Number.isFinite));
  const performance = { classification: "instrumented visible five-star development run, not sustained acceptance",
    engine: report.engine, checkpointSha256: sha256, cpu: cpus()[0]?.model, graphics: timing.graphics,
    frameMs: percentiles(timing.intervals), fixedStepMs: percentiles(timing.ticksMs),
    viewSyncMs: percentiles(timing.syncMs), viewPrepareMs: percentiles(timing.prepareMs),
    observedInferenceAndGuardMs: percentiles(timing.inferenceMs), bins: timing.bins };
  await writeFile(join(output, "pursuit-performance.json"), JSON.stringify(performance, null, 2));
  await page.locator("#pauseBtn").click();
  assert.equal(await page.evaluate(() => window.sim.paused), true);
  report.outcome = await page.evaluate(() => {
    const { pursuit: run } = window.sim.world;
    return { phase: run.phase, level: run.level, startedTick: run.startedTick,
      endedTick: run.endedTick, qualified: run.response.dispatch.escapeEligible,
      driver: run.frozenDriver.status, sha256: run.frozenDriver.sha256, decisions: run.frozenDriver.decisions,
      distanceM: run.metrics.distanceM, egoContacts: run.metrics.collisions,
      ambientContacts: run.metrics.trafficCollisions };
  });
  assert.deepEqual([report.outcome.phase, report.outcome.level, report.outcome.startedTick, report.outcome.qualified,
    report.outcome.driver, report.outcome.sha256, report.outcome.egoContacts], ["escaped", 5, 0, true, "active", sha256, 0]);
  assert.ok(report.outcome.distanceM > 200 && report.outcome.decisions > 500);
  await page.screenshot({ path: join(output, "live-outcome.png") });
  const expected = await snapshot(page);
  await writeFile(join(output, "live-snapshot.json"), JSON.stringify(expected));
  await clickCityTool(page, "settingsBtn");
  const downloadWait = page.waitForEvent("download");
  await page.locator("#replayBtn").click();
  const file = join(output, "actual-replay.json");
  await (await downloadWait).saveAs(file);
  await original.close();

  const bytes = await readFile(file);
  const replay = JSON.parse(bytes);
  const start = replay.events.find(row => row.command.type === "street-pursuit-start");
  assert.equal(replay.environment, "metro");
  assert.equal(replay.totalTicks, expected.tick);
  assert.equal(start.command.config.ruleset, "dispatch-v1");
  assert.ok(!bytes.includes(sha256) && !bytes.includes('"frozenDriver"') && !bytes.includes('"checkpoint"'));
  assert.ok(!replay.events.some(row => row.command.type === "pursuit-use"));
  const driveCount = replay.events.filter(row => row.command.type === "pursuit-drive").length;
  assert.equal(driveCount, report.outcome.decisions);
  report.download = { ticks: replay.totalTicks, driveCount, bytes: bytes.length, sha256: digest(bytes) };

  const receiving = await browser.newContext(contextOptions);
  const receiver = await openPaused(receiving);
  const originalReceiver = await snapshot(receiver);
  const invalid = structuredClone(replay);
  invalid.events[0].command.type = "invalid-replay-control";
  await importReplay(receiver, Buffer.from(JSON.stringify(invalid)), "invalid-event.json", "Could not load replay: Invalid replay event");
  assert.deepEqual(await snapshot(receiver), originalReceiver);
  report.invalidRejected = true;

  await importReplay(receiver, bytes, "actual-replay.json");
  const restored = await snapshot(receiver);
  await writeFile(join(output, "restored-snapshot.json"), JSON.stringify(restored));
  report.decodedDriver = await receiver.evaluate(() => Boolean(window.sim.world.pursuit.frozenDriver));
  report.population = restored.actors.reduce((counts, actor) => {
    if (actor.type === "pedestrian") counts.pedestrians++;
    if (actor.type === "vehicle" && !actor.pursuitRole && actor.id !== "player") counts.vehicles++;
    return counts;
  }, { vehicles: 0, pedestrians: 0 });
  report.liveDigest = digest(JSON.stringify(expected));
  report.restoredDigest = digest(JSON.stringify(restored));
  report.exactSnapshot = isDeepStrictEqual(expected, restored);
  report.differentFields = Object.keys(expected).filter(key => !isDeepStrictEqual(expected[key], restored[key]));
  await receiver.locator("#closeSettings").click();
  await receiver.screenshot({ path: join(output, "restored-outcome.png") });
  assert.equal(report.decodedDriver, false);
  assert.deepEqual(report.population, { vehicles: 96, pedestrians: 144 });
  assert.ok(report.exactSnapshot, JSON.stringify(report.differentFields));

  await clickCityTool(receiver, "settingsBtn");
  const index = replay.events.findIndex(row => row.command.type === "pursuit-drive" && row.command.action.throttle > .6);
  assert.ok(index > 0 && replay.events[index].tick < 120);
  const prefix = { ...replay, totalTicks: replay.events[index].tick + 6, events: replay.events.slice(0, index + 1) };
  const motion = () => receiver.evaluate(() => {
    const { tick, player: { x, z, speed } } = window.sim.world;
    return { tick, x, z, speed };
  });
  await importReplay(receiver, Buffer.from(JSON.stringify(prefix)), "recorded-prefix.json");
  const recorded = await motion();
  const changed = structuredClone(prefix);
  changed.events[index].command.action = { steer: 0, throttle: 0, brake: 1, gear: 1 };
  await importReplay(receiver, Buffer.from(JSON.stringify(changed)), "braking-prefix.json");
  const braking = await motion();
  report.prefixControl = { recorded, braking, changedTick: replay.events[index].tick };
  report.actionControlChangedMotion = recorded.tick === braking.tick && recorded.speed > braking.speed + .1 &&
    Math.hypot(recorded.x - braking.x, recorded.z - braking.z) > .005;
  assert.ok(report.actionControlChangedMotion);
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(join(output, "replay-proof.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
