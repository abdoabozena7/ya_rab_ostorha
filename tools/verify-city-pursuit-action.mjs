import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const craft = process.env.CITY_PURSUIT_CRAFT === "1";
assert.ok(output && base, "Run this check through verify_city_pursuit_action.py");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(25_000);
const report = { passed: false, errors: [] };
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()}: ${response.url()}`); });
const button = id => page.locator(`#${id}`);
const shot = name => page.screenshot({ path: join(output, name) });
const wait = (fn, arg) => page.waitForFunction(fn, arg);
const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

async function prepare(dense) {
  await page.goto(base);
  await button("pauseBtn").click();
  if (dense) {
    await button("settingsBtn").click();
    await page.locator('[name="speedLimit"]').fill("50");
    await page.locator('[name="difficulty"]').fill("5");
    await page.locator('[name="scenarioInterval"]').fill("2");
    await button("stressBtn").click();
    await wait(() => window.sim.world.capacity.pedestrians === 144);
    await button("closeSettings").click();
  }
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await button("streetPursuitBtn").click();
  if (dense) await button("pursuitLevel").selectOption("4");
  assert.equal(await button("pursuitLevel").inputValue(), dense ? "4" : "3");
  await page.evaluate(() => {
    const { world, view } = window.sim;
    window.__pursuitCheck = { world, scene: view.scene, original: [...world.actors], player: world.player };
  });
}

async function chase(seconds) {
  await startArcadeReplay();
  const run = await page.evaluate(seconds => new Promise(resolve => {
    const { world, view } = window.sim, { pursuit, player } = world;
    const rawStep = world.step, rawPrepare = view.prepareFrame;
    const timeline = [], framesMs = [], stepMs = [], prepareMs = [];
    let display = null;
    world.step = function () {
      const start = performance.now();
      try { return rawStep.call(this); }
      finally { stepMs.push(performance.now() - start); }
    };
    view.prepareFrame = function (options) {
      display = options.cameras[0];
      const start = performance.now();
      try { return rawPrepare.call(this, options); }
      finally { prepareMs.push(performance.now() - start); }
    };
    const started = performance.now(), initialTick = world.tick;
    const targetTick = pursuit.startedTick + (pursuit.variant === "arcade" ? 390 : 0);
    const initial = window.sim.renderDiagnostics();
    const rear = [...pursuit.patrols].find(actor => actor.policeTactic === "tail");
    let prior = started, sampled = -Infinity;
    function fullSilhouette(car, root, point) {
      if (!display || !root) return false;
      const { x, y, z } = root.position, yaw = root.rotation.y;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      for (const side of [-.5, .5]) for (const end of [-.5, .5])
        for (const top of [0, (car.height ?? 1.5) + .13]) {
          const across = side * car.width, along = end * car.length;
          point.set(x + across * c + along * s, y + top, z + along * c - across * s).project(display);
          if (point.z < -1 || point.z > 1 || Math.abs(point.x) > .94 || point.y < -.9 || point.y > .94)
            return false;
        }
      return true;
    }
    const readActors = () => [...pursuit.patrols].map(car => {
      const root = view.roots.get(car.id)?.root;
      const clip = display && root?.position.clone().add({ x: 0, y: 1, z: 0 }).project(display);
      const inView = Boolean(clip && clip.z > -1 && clip.z < 1 &&
        Math.abs(clip.x) < .94 && Math.abs(clip.y) < .94);
      const forwardM = (car.x - player.x) * Math.sin(player.heading) +
        (car.z - player.z) * Math.cos(player.heading);
      return { id: car.id, pattern: car.policeTactic, x: car.x, z: car.z,
        movedM: car.distance, speedMps: car.speed, gapM: Math.hypot(car.x - player.x, car.z - player.z),
        forwardM, inView, fullInView: inView && fullSilhouette(car, root, clip) };
    });
    function sample(now) {
      framesMs.push(now - prior);
      prior = now;
      const done = (now - started >= seconds * 1000 && world.tick >= targetTick) ||
        now - started >= 15_000 || pursuit.phase !== "running";
      if (now - sampled >= 90 || done) {
        timeline.push({ t: (now - started) / 1000, tick: world.tick, phase: pursuit.phase,
          x: player.x, z: player.z, speedMps: player.speed, reason: player.reason,
          playerM: pursuit.metrics.distanceM, patrols: readActors(),
          wantedLevel: pursuit.wantedLevel ?? null,
          wantedLabel: document.getElementById("pursuitWanted")?.getAttribute("aria-label") ?? null,
          response: pursuit.response ? { stage: pursuit.response.stage,
            unitsInContact: pursuit.response.unitsInContact } : null,
          cameraDistanceM: display?.position.distanceTo(view.roots.get(player.id).root.position) ?? null });
        sampled = now;
      }
      if (!done) return requestAnimationFrame(sample);
      delete view.prepareFrame;
      delete world.step;
      const final = window.sim.renderDiagnostics(), before = window.__pursuitCheck;
      resolve({ timeline, framesMs, stepMs, prepareMs,
        fps: (final.renderedFrames - initial.renderedFrames) * 1000 / (now - started),
        physicsHz: (world.tick - initialTick) * 1000 / (now - started), sameCity: world === before.world &&
          view.scene === before.scene && player === before.player && before.original.every(a => world.actors.includes(a)),
        crowd: before.original.filter(actor => actor.type === "pedestrian" && actor.distance > 1).length,
        population: world.capacity, rearId: rear?.id, level: pursuit.level, variant: pursuit.variant,
        startedTick: pursuit.startedTick, learning: pursuit.learner?.snapshot() ?? null,
        audit: world.audit(), metrics: pursuit.metrics, events: pursuit.events,
        scenery: view.egyptStreets.diagnostics, render: final });
    }
    requestAnimationFrame(sample);
  }), seconds);
  const last = run.timeline.at(-1), fast = run.timeline.filter(item => item.speedMps >= 11);
  const gapsAtSpeed = fast.flatMap(item => item.patrols.filter(car => car.id === run.rearId).map(car => car.gapM));
  const initialGap = run.timeline[0].patrols.find(car => car.id === run.rearId)?.gapM;
  return { ...run, first: run.timeline[0], last, p95Ms: p95(run.framesMs),
    physicsP95Ms: p95(run.stepMs), prepareP95Ms: p95(run.prepareMs),
    peakMps: Math.max(...run.timeline.map(item => item.speedMps)),
    peakPatrolMps: Math.max(...run.timeline.flatMap(item => item.patrols.map(car => car.speedMps))),
    rearGainAtSpeedM: gapsAtSpeed.length ? initialGap - Math.min(...gapsAtSpeed) : 0,
    movingInView: [...new Set(run.timeline.flatMap(item => item.patrols.filter(car =>
      car.inView && car.speedMps > 2 && car.movedM > 3).map(car => car.id)))],
  };
}

// This verifier protects the previously shipped arcade rules; the default UI
// now launches pack. The current public journey is exercised by verify-pack-pursuit.mjs.
async function startArcadeReplay(learn = false) {
  const level = Number(await button("pursuitLevel").inputValue());
  await page.evaluate(({ level, learn }) => {
    window.sim.command({ type: "street-pursuit-start", level, variant: "arcade", learn });
    window.sim.pause(false);
  }, { level, learn });
}

function expectArcade(run, initialCount, initialStars) {
  assert.ok(run.first.patrols.length >= initialCount && run.sameCity);
  assert.equal(run.first.wantedLevel, initialStars);
  assert.equal(run.last.wantedLevel, 5);
  assert.equal(run.learning, null, "Learning is opt-in");
  assert.ok(run.peakPatrolMps >= run.peakMps + 3, "A patrol actually outruns the SUV, not just on paper");
  assert.deepEqual(run.events.filter(e => e.kind === "reinforcement").slice(0, 2)
    .map(e => e.tick - run.startedTick), [180, 360]);
  for (let stars = initialStars; stars <= 5; stars++)
    assert.ok(run.timeline.some(frame => frame.wantedLabel === `Wanted level ${stars} of 5`));
}

async function practice() {
  await prepare(false);
  await button("pursuitLearn").check();
  await startArcadeReplay(true);
  const updates = () => page.evaluate(() => window.sim.world.pursuit.learner.snapshot().updates);
  await wait(() => window.sim.world.pursuit.learner?.snapshot().updates >= 5);
  assert.match(await button("pursuitLearning").innerText(), /RL practice · \d+ updates/);
  await shot("06-practice-active.png");
  await button("aiToggleBtn").click();
  await wait(() => window.sim.world.mode === "manual");
  const atManual = await updates();
  const before = await page.evaluate(() => {
    const { tick, player } = window.sim.world;
    return { tick, x: player.x, z: player.z };
  });
  await page.keyboard.down("ArrowUp");
  try {
    await wait(prior => {
      const { tick, player } = window.sim.world;
      return tick >= prior.tick + 18 && Math.hypot(player.x - prior.x, player.z - prior.z) > .25;
    }, before);
  } finally {
    await page.keyboard.up("ArrowUp");
  }
  assert.equal(await updates(), atManual);
  assert.match(await button("pursuitLearning").innerText(), /on hold/);
  await button("aiToggleBtn").click();
  await wait(prior => window.sim.world.pursuit.learner.snapshot().updates > prior, atManual);
  const afterResume = await updates();
  await button("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "stopped");
  const atEnd = await updates();
  await startArcadeReplay(true);
  await wait(() => window.sim.world.pursuit.run === 2);
  const restart = await page.evaluate(() => {
    const { world } = window.sim;
    return { sameCity: world === window.__pursuitCheck.world,
      updates: world.pursuit.learner.snapshot().updates, states: world.pursuit.learner.snapshot().states };
  });
  assert.ok(restart.sameCity && restart.updates >= atEnd && restart.states > 0);
  await button("pursuitRestartBtn").click();
  return { updatesAtManual: atManual, updatesAfterResume: afterResume, updatesAtEnd: atEnd, restart };
}

try {
  await prepare(false);
  await shot("01-city-pursuit-ready.png");
  report.defaultRun = await chase(5.5);
  await shot("02-default-pursuit-moving.png");
  const arcade = report.defaultRun.variant === "arcade";
  const cinematic = arcade || report.defaultRun.variant === "cinematic";
  if (craft) assert.equal(cinematic, true);
  else assert.ok(cinematic || report.defaultRun.variant === "rush");
  assert.equal(report.defaultRun.level, 3);
  assert.deepEqual(report.defaultRun.population, { traffic: 36, pedestrians: 80 });
  assert.ok(report.defaultRun.first.patrols.length >= 4 && report.defaultRun.last.playerM > 18);
  if (arcade) expectArcade(report.defaultRun, 8, 3);

  await prepare(true);
  report.dense = await chase(6.2);
  await shot("03-max-density-active-pursuit.png");
  const dense = report.dense;
  assert.equal(dense.variant, report.defaultRun.variant);
  assert.deepEqual(dense.population, { traffic: 96, pedestrians: 144 });
  assert.deepEqual(dense.audit, []);
  assert.ok(dense.crowd > 100 && dense.sameCity && dense.metrics.pedestrianCollisions === 0);
  assert.ok(dense.last.patrols.length >= 8 && dense.last.patrols.filter(car => car.movedM >= 8).length >= 3);
  assert.ok(dense.events.some(event => event.kind === "reinforcement"));
  if (arcade) expectArcade(dense, 10, 4);
  assert.ok(dense.last.playerM >= (cinematic ? 30 : 35) && dense.peakMps >= (cinematic ? 10.5 : 11) &&
    (cinematic || dense.rearGainAtSpeedM >= 3),
    JSON.stringify({ playerM: dense.last.playerM, peakMps: dense.peakMps, rearGainAtSpeedM: dense.rearGainAtSpeedM }));
  assert.ok(dense.movingInView.length >= 2, JSON.stringify(dense.movingInView));
  assert.deepEqual([dense.render.width, dense.render.height, dense.render.pixelRatio], [1365, 900, 1]);
  assert.ok(dense.fps >= 25 && dense.physicsHz >= 45 && dense.p95Ms <= 75,
    JSON.stringify({ fps: dense.fps, physicsHz: dense.physicsHz, p95Ms: dense.p95Ms }));
  assert.ok(dense.scenery.residentCells < dense.scenery.totalCells);
  if (cinematic) {
    assert.ok(dense.timeline.some(frame => frame.response?.stage === "contact" &&
      frame.response.unitsInContact > 0 && frame.speedMps > 7));
    assert.ok(dense.timeline.some(frame => frame.cameraDistanceM > 3 && frame.cameraDistanceM < 18));
    if (!arcade) assert.ok(dense.timeline.some(frame => frame.speedMps >= 10.5 && frame.patrols.some(car =>
        car.fullInView && car.gapM <= 15 && car.forwardM < -2 && car.movedM >= 8)),
      "A close rear patrol must fit with room for its whole footprint while the SUV is moving at avenue pace");
    const details = page.locator("#pursuitPanel details");
    assert.equal(await details.count(), 1);
    assert.equal(await details.getAttribute("open"), null, "Diagnostics must be closed during play");
    assert.equal(await button("cameraLabel").isVisible(), false, "The driving view starts uncluttered");
    await details.locator("summary").click();
    assert.equal(await button("pursuitDecision").isVisible(), true);
    await details.locator("summary").click();
    await button("cameraBtn").click();
    assert.equal(await button("cameraLabel").isVisible(), true);
    await button("cameraBtn").click();
    assert.equal(await button("cameraLabel").isVisible(), false);
  }

  await page.setViewportSize({ width: 900, height: 650 });
  await wait(() => window.sim.renderDiagnostics().width === 900);
  if (arcade) {
    await button("pauseBtn").click();
    await wait(() => document.getElementById("pursuitPhase").textContent === "Paused");
    const tick = await page.evaluate(() => window.sim.world.tick);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.sim.world.tick), tick);
    assert.equal(await button("pursuitWanted").getAttribute("aria-label"), "Wanted level 5 of 5");
  }
  const hud = await button("pursuitPanel").boundingBox(), map = await button("minimap").boundingBox();
  assert.ok(hud && map && hud.y + hud.height <= map.y, "Compact pursuit HUD must not cover the map");
  await shot("04-compact-pursuit.png");
  await button("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "stopped");
  if (arcade) assert.equal(await button("pursuitHeat").isVisible(), false);
  report.returned = await page.evaluate(() => {
    const { world, view } = window.sim, before = window.__pursuitCheck;
    return world === before.world && view.scene === before.scene && world.player === before.player &&
      world.actors.length === before.original.length && before.original.every(a => world.actors.includes(a)) &&
      world.mode === "manual";
  });
  assert.equal(report.returned, true);
  if (cinematic) assert.equal(await button("cameraLabel").isVisible(), true,
    "The ordinary camera-preview preference is restored after ending pursuit");
  await shot("05-pursuit-ended-same-city.png");
  if (cinematic) {
    await startArcadeReplay();
    await wait(() => window.sim.world.pursuit?.phase === "running" &&
      window.sim.world.pursuit.run === 2);
    report.restarted = await page.evaluate(() => {
      const { world, view } = window.sim, before = window.__pursuitCheck;
      return world === before.world && view.scene === before.scene &&
        world.pursuit.metrics.distanceM < 3 &&
        [...world.pursuit.patrols].every(car => car.id.startsWith("street-pursuit-2-"));
    });
    assert.equal(report.restarted, true);
    await button("pursuitRestartBtn").click();
    await wait(() => window.sim.world.pursuit?.phase === "stopped");
  }
  if (arcade) {
    await page.setViewportSize({ width: 1365, height: 900 });
    report.practice = await practice();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await shot("failure.png");
  throw error;
} finally {
  await writeFile(join(output, craft ? "pursuit-craft.json" : "pursuit-action.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
