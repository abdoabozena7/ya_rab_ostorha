import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url } = process.env;
assert.ok(output && url);
const digest = value => createHash("sha256").update(value).digest("hex");
const origin = new URL(
  "../.runtime-proof/pursuit-rl-civilian-motion-20261121/runs/public/20261121T020722-683577eb97/", import.meta.url);
const expectedReplay = "8e5adfcec602ba22d23993afdf341f7c86cab5c7571b46dc5133965a9599a067";
const expectedWorld = "4aed62dddbb44b0360ad2f302794fe61f17f95ce0998d8956117e5debee6884e";
const bytes = await readFile(new URL("actual-replay.json", origin));
assert.equal(digest(bytes), expectedReplay);
const saved = JSON.parse(bytes);
const timed = process.env.REPLAY_CHUNK_ACCEPTANCE === "1";
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const report = { engine: browser.version(), inputSha256: expectedReplay, expectedWorld, errors: [] };
const terminal = "Replay restored from recorded commands.";

try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
  page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
  await page.bringToFront();
  await page.locator("#pauseBtn").click();
  await page.locator("#settingsBtn").click();
  await page.evaluate(() => {
    const originWorld = window.sim.world, status = document.getElementById("replayProgress");
    const samples = { intervals: [], paints: 0, progressSamples: [], retainedSource: true, longTasks: [] };
    const entries = new PerformanceObserver(list => samples.longTasks.push(
      ...list.getEntries().map(({ startTime, duration }) => [startTime, duration])));
    entries.observe({ entryTypes: ["longtask"] });
    let active = false, previousTime = null, previousPercent;
    function tick(time) {
      const current = /^Replaying: (\d+)%$/.exec(status.textContent);
      if (current) {
        active = true;
        const pct = Number(current[1]);
        if (previousTime !== null && pct >= 3 && pct < 98) samples.intervals.push(time - previousTime);
        samples.paints++;
        if (pct !== previousPercent) samples.progressSamples.push([pct, time]);
        previousTime = time;
        previousPercent = pct;
        samples.retainedSource &&= window.sim.world === originWorld && window.sim.paused;
      } else if (active) {
        entries.disconnect();
        window.__replayTiming = samples;
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  const file = (name, buffer) => page.locator("#replayFile").setInputFiles({ name, mimeType: "application/json", buffer });
  const started = performance.now();
  await file("actual-replay.json", bytes);
  const progress = page.locator("#replayProgress");
  try {
    await page.waitForFunction(() => /^(Replaying: |Could not load replay:|Replay import canceled)/.test(
      document.getElementById("replayProgress").textContent), null, { polling: 100, timeout: 8000 });
  } catch (error) {
    report.firstStatus = await progress.textContent();
    report.fileCount = await page.locator("#replayFile").evaluate(input => input.files.length);
    throw error;
  }
  report.firstStatus = await progress.textContent();
  assert.match(report.firstStatus, /^Replaying: /);
  await page.locator("#settingsBtn").click();
  assert.equal(await page.locator("#settingsPanel").isVisible(), false);
  await page.locator("#settingsBtn").click();
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "replay-in-progress.png") });
  const waitFinished = () => page.waitForFunction(text =>
    document.getElementById("replayProgress").textContent === text &&
    document.getElementById("replayFile").files.length === 0, terminal, { polling: 250, timeout: 160_000 });
  await waitFinished();
  await page.waitForFunction(() => Boolean(window.__replayTiming));
  const telemetry = await page.evaluate(() => window.__replayTiming);
  const snapshot = () => page.evaluate(() => window.sim.snapshot());
  const full = await snapshot();
  const percentiles = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return { count: values.length, p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, max: sorted.at(-1) ?? null };
  };
  const start = telemetry.progressSamples[0][1], end = telemetry.progressSamples.at(-1)[1];
  report.import = { seconds: (performance.now() - started) / 1000, paints: telemetry.paints,
    progressSamples: telemetry.progressSamples, retainedSource: telemetry.retainedSource,
    frameGapMs: percentiles(telemetry.intervals),
    longTasksMs: percentiles(telemetry.longTasks.filter(([t]) => t >= start && t <= end).map(([, ms]) => ms)),
    exactSnapshot: digest(JSON.stringify(full)) === expectedWorld, ticks: full.tick,
    noModel: await page.evaluate(() => !window.sim.world.pursuit?.frozenDriver) };
  assert.ok(report.import.exactSnapshot && report.import.noModel && report.import.retainedSource && report.import.paints > 10);
  assert.equal(report.import.ticks, saved.totalTicks);
  await page.locator("#settingsBtn").click();
  await page.screenshot({ path: join(output, "replay-final.png") });
  await page.locator("#settingsBtn").click();
  if (timed) {
    const next = structuredClone(saved);
    next.events[0].command.type = "invalid-replay-control";
    await file("invalid-replay.json", Buffer.from(JSON.stringify(next)));
    await page.waitForFunction(() => document.getElementById("replayProgress").textContent ===
      "Could not load replay: Invalid replay event");
    report.invalidRetained = digest(JSON.stringify(await snapshot())) === expectedWorld;
    assert.ok(report.invalidRetained);
    const prefix = ticks => ({ ...saved, totalTicks: ticks, events: saved.events.filter(event => event.tick < ticks) });
    await file("superseded-prefix.json", Buffer.from(JSON.stringify(prefix(240))));
    await page.waitForFunction(() => /^Replaying: /.test(document.getElementById("replayProgress").textContent));
    await file("short-replay.json", Buffer.from(JSON.stringify(prefix(6))));
    await waitFinished();
    const short = await snapshot();
    await page.waitForTimeout(5000);
    report.newerKept = short.tick === 6 && digest(JSON.stringify(await snapshot())) === digest(JSON.stringify(short));
    assert.ok(report.newerKept);
    assert.ok(report.import.frameGapMs.p95 < 100);
    assert.ok(report.import.progressSamples.length > 40);
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(join(output, "replay-responsiveness.json"), JSON.stringify(report, null, 2));
  const summary = report.import && { ...report.import, progressSamples: report.import.progressSamples.length };
  console.log(JSON.stringify({ engine: report.engine, import: summary, invalidRetained: report.invalidRetained,
    newerKept: report.newerKept, errors: report.errors }));
}
