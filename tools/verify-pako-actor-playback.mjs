import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const negative = process.argv.includes("--negative-control");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
const id = name => page.locator(`#${name}`);
const shot = name => page.screenshot({ path: join(output, `${name}-replay.png`) });
const wait = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
const report = { passed: false, missingActorRecording: false, base, browser: browser.version(), errors: [] };
page.on("pageerror", error => report.errors.push(error.message));
page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
await page.addInitScript(omit => {
  const NativeWorker = window.Worker;
  window.__episodesWithActors = new Map();
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (!String(url).endsWith("pursuit-lab-worker.bundle.js")) return;
      this.addEventListener("message", event => {
        if (!event.data.actorRecording) return;
        const { actorRecording, ...metadata } = event.data;
        if (omit) {
          event.stopImmediatePropagation();
          this.dispatchEvent(new MessageEvent("message", { data: metadata }));
        } else window.__episodesWithActors.set(metadata.lastEpisode.id, actorRecording);
      });
    }
  };
}, negative);

async function completed(button) {
  await id(button).click();
  await wait(() => ["completed", "fault"].includes(window.sim.pursuitTraining?.status), null, 111000);
  const session = await page.evaluate(() => window.sim.pursuitTraining);
  assert.equal(session.status, "completed", session.error);
  assert.equal(session.episodes, 1);
  assert.ok(session.lastEpisode.ticks >= 60);
  return session;
}

async function watch() {
  await id("pakoWatchLast").click();
  await wait(() => window.sim.ghostReplay?.count === 1 && window.sim.ghostReplay.tick > 12);
}

async function seek(tick) {
  await id("pakoGhostTime").evaluate((slider, tick) => {
    slider.value = String(tick);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }, tick);
  await wait(value => window.sim.ghostReplay?.tick === value, tick);
}

async function verifySample(episode, tick) {
  await seek(tick);
  const { expected, rendered } = await page.evaluate(({ id, tick }) => {
    const { actors, frames } = window.__episodesWithActors.get(id);
    const sample = frames.find(frame => frame.ego[0] === tick);
    const expected = { pedestrians: 0, patrols: 0, traffic: 0, examples: {}, ego: sample.ego };
    for (let offset = 0; offset < sample.poses.length; offset += 5) {
      const actor = actors[sample.poses[offset]];
      const type = actor.type === "pedestrian" ? "pedestrians" : actor.pursuitRole === "police" ? "patrols" : "traffic";
      expected[type]++;
      expected.examples[type] ??= { id: actor.id, x: sample.poses[offset + 1], z: sample.poses[offset + 2] };
    }
    return { expected, rendered: window.sim.ghostReplay };
  }, { id: episode.id, tick });
  assert.equal(rendered.selected[0].id, episode.id);
  for (const [i, key] of [[1, "x"], [2, "z"], [4, "heading"]])
    assert.ok(Math.abs(rendered.selected[0][key] - expected.ego[i]) < .0001);
  assert.deepEqual(rendered.recordedActors, {
    pedestrians: expected.pedestrians, patrols: expected.patrols, traffic: expected.traffic, examples: expected.examples,
  });
  return rendered.recordedActors;
}

try {
  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await page.evaluate(() => {
    window.__metro = window.sim.world;
    window.__actors = [...window.sim.world.actors];
  });
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  await id("pako-training").click();
  await id("pakoLabSetup").locator("summary").click();
  await id("pakoEpisodeLimit").fill("1");
  await id("pakoTimeLimit").fill("140");
  await id("pakoLabSetup").locator("summary").click();
  const trained = await completed("pakoTrain");
  assert.equal(trained.updates, 1);
  await watch();
  await shot("training");
  const received = await page.evaluate(episode => window.__episodesWithActors.has(episode), trained.lastEpisode.id);
  const sawActors = await page.evaluate(() => Boolean(window.sim.ghostReplay.recordedActors));
  report.openedReplay = { episode: trained.lastEpisode.id, phase: trained.lastEpisode.phase,
    ticks: trained.lastEpisode.ticks, received, sawActors };
  report.missingActorRecording = !received && !sawActors;
  if (negative && report.missingActorRecording) {
    assert.deepEqual(report.errors, []);
    process.exitCode = 3;
  } else {
    assert.ok(received && sawActors && !negative, "Public replay did not show the completed worker recording");
    assert.match(await id("pakoGhostSummary").textContent(), /recorded traffic, people and patrols/i);
    const first = await verifySample(trained.lastEpisode, 0);
    assert.equal(first.traffic, 96);
    assert.equal(first.pedestrians, 144);
    assert.ok(first.patrols >= 2);
    await shot("opening");
    await id("pakoGhostStep").click();
    assert.equal(await id("pakoGhostTime").inputValue(), "6");
    const motionTick = Math.min(180, trained.lastEpisode.ticks - trained.lastEpisode.ticks % 6);
    const moving = await verifySample(trained.lastEpisode, motionTick);
    for (const type of ["traffic", "pedestrians"]) {
      const a = first.examples[type], b = moving.examples[type];
      assert.equal(a.id, b.id);
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > .2, `${type} did not move`);
    }
    await shot("moving");
    await seek(0);
    await id("pakoGhostPlay").click();
    const playback = await page.evaluate(() => new Promise(resolve => {
      const start = performance.now(), startTick = window.sim.ghostReplay.tick, gaps = [];
      const startRendered = window.sim.renderDiagnostics().renderedFrames;
      let prev = start;
      function frame(now) {
        gaps.push(now - prev);
        prev = now;
        if (now - start < 2050) return requestAnimationFrame(frame);
        gaps.sort((a, b) => a - b);
        resolve({ frames: gaps.length, p95GapMs: gaps[Math.floor((gaps.length - 1) * .95)],
          renderedFrames: window.sim.renderDiagnostics().renderedFrames - startRendered,
          wallMs: now - start, ticks: window.sim.ghostReplay.tick - startTick });
      }
      requestAnimationFrame(frame);
    }));
    assert.ok(playback.ticks > 90 && playback.ticks < 160 && playback.renderedFrames > 25, JSON.stringify(playback));
    const terminal = await verifySample(trained.lastEpisode, trained.lastEpisode.ticks);
    await shot("terminal");
    report.training = { episode: trained.lastEpisode.id, outcome: trained.lastEpisode.phase,
      ticks: trained.lastEpisode.ticks, first, moving, terminal, playback };

    await page.setViewportSize({ width: 390, height: 844 });
    await verifySample(trained.lastEpisode, motionTick);
    await id("pakoGhostTime").scrollIntoViewIfNeeded();
    report.mobile = await page.evaluate(() => {
      const panel = document.getElementById("settingsPanel").getBoundingClientRect();
      const slider = document.getElementById("pakoGhostTime").getBoundingClientRect();
      return { fitsViewport: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
        visibleSlider: slider.top >= panel.top && slider.bottom <= panel.bottom };
    });
    assert.deepEqual(report.mobile, { fitsViewport: true, visibleSlider: true });
    await shot("mobile");
    await page.setViewportSize({ width: 1365, height: 900 });

    const tested = await completed("pakoEvaluate");
    assert.equal(tested.updates, trained.updates);
    assert.equal(tested.optimizerSteps, trained.optimizerSteps);
    assert.notEqual(tested.lastEpisode.id, trained.lastEpisode.id);
    assert.notEqual(tested.lastEpisode.seed, trained.lastEpisode.seed);
    await watch();
    const frozen = await verifySample(tested.lastEpisode, 0);
    assert.equal(frozen.traffic, 96);
    assert.equal(frozen.pedestrians, 144);
    report.testing = { episode: tested.lastEpisode.id, outcome: tested.lastEpisode.phase,
      ticks: tested.lastEpisode.ticks, first: frozen, optimizerSteps: tested.optimizerSteps };
    await shot("frozen");

    await id("pakoLabSetup").locator("summary").click();
    await id("metroPpoStage").selectOption("maneuver");
    await id("pakoLabSetup").locator("summary").click();
    const archived = await completed("pakoTrain");
    await watch();
    assert.equal(await page.evaluate(() => window.sim.ghostReplay.recordedActors), undefined);
    assert.match(await id("pakoGhostSummary").textContent(), /SUV path only/i);
    assert.ok(!await page.evaluate(id => window.__episodesWithActors.has(id), archived.lastEpisode.id));
    await shot("archive");
    await page.getByRole("button", { name: "Return to city", exact: true }).click();
    await wait(() => window.sim.world === window.__metro && !window.sim.ghostReplay);
    assert.ok(await page.evaluate(() => window.__actors.every(actor => window.sim.world.actors.includes(actor))));
    assert.deepEqual(report.errors, []);
    report.passed = true;
  }
} catch (error) {
  report.failure = error.stack;
  await shot("failed");
  throw error;
} finally {
  await writeFile(join(output, "actor-playback.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
