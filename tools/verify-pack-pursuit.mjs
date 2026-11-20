import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(14_000);
const report = { lab: {}, city: {}, errors: [], order: [] };
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
page.on("response", response => { if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`); });
const id = value => page.locator(`#${value}`);
const wait = (fn, arg) => page.waitForFunction(fn, arg);
const shot = name => page.screenshot({ path: join(output, `${name}.png`) });
const read = () => page.evaluate(() => {
  const { world, view } = window.sim, { pursuit: p, player } = world;
  const people = world.actors.filter(actor => actor.type === "pedestrian");
  return { tick: world.tick, startedTick: p?.startedTick, x: player.x, z: player.z,
    phase: p?.phase, metrics: p?.metrics, learning: p?.learner?.snapshot(), decision: p?.decision,
    variant: p?.variant, driver: p?.driver, patrols: p?.patrols?.size,
    posedPeople: people.filter(actor => actor.impact || view.roots.get(actor.id)?.root.userData.pedestrianImpactPose).length };
});

async function observe() {
  await page.evaluate(() => {
    const { world } = window.sim;
    const originals = [...world.actors];
    const step = world.step, rows = [];
    window.__packEvidence = { world, originals, rows };
    world.step = function () {
      const before = this.tick;
      step.call(this);
      if (before === this.tick || rows.length >= 1800) return;
      const p = this.pursuit, a = this.player;
      if (!p || p.startedTick === null) return;
      const units = [...p.patrols].map(car => ({
        id: car.id, x: car.x, z: car.z, speed: car.speed, gap: Math.hypot(car.x - a.x, car.z - a.z),
      }));
      const sectors = new Set(units.filter(u => u.gap <= 22).map(u => {
        const bearing = Math.atan2(u.x - a.x, u.z - a.z) - a.heading;
        return Math.round(Math.atan2(Math.sin(bearing), Math.cos(bearing)) / (Math.PI / 2)) & 3;
      }));
      const earlier = rows.at(-9)?.units;
      const closing = earlier ? units.filter(u => u.gap <= 22 &&
        earlier.find(row => row.id === u.id)?.gap - u.gap > .18).length : 0;
      rows.push({ tick: this.tick, elapsed: this.tick - p.startedTick, phase: p.phase,
        x: a.x, z: a.z, speed: a.speed, steer: a.steer, heading: a.heading,
        units, sectors: sectors.size, closing, person: p.metrics.pedestrianStatus,
        poly: p.decision?.source, index: p.decision?.index, key: p.decision?.key,
        reward: p.learner?.snapshot().lastReward });
    };
  });
}

async function measurePack(name) {
  const evidence = await page.evaluate(() => {
    const { world, rows } = window.__packEvidence;
    const active = rows.filter(row => row.phase === "running");
    const best = active.filter(row => row.closing >= 2).sort((a, b) => b.sectors - a.sectors)[0];
    return { sectors: best?.sectors ?? 0, simultaneouslyClosing: best?.closing ?? 0,
      peakSUV: Math.max(0, ...active.map(row => row.speed)),
      peakPolice: active.reduce((peak, row) => Math.max(peak, ...row.units.map(unit => unit.speed)), 0),
      events: world.pursuit.events, trace: rows, audit: world.audit() };
  });
  if (name === "lab") report.lab.dodge = evidence;
  else report.city.pack = evidence;
  assert.ok(evidence.sectors >= 3 && evidence.simultaneouslyClosing >= 2,
    `Expected live concurrent pressure from at least 3 angles (${name}): ${JSON.stringify({ sectors: evidence.sectors, events: evidence.events })}`);
  assert.deepEqual(evidence.audit, []);
  return evidence;
}

async function observeLabFraming() {
  await page.evaluate(() => {
    const { view } = window.sim;
    const prepare = view.prepareFrame;
    view.prepareFrame = function (options) {
      window.__labDisplay = options.cameras[0];
      return prepare.call(this, options);
    };
  });
}

async function assertLabFraming() {
  const { actors, overlays } = await page.evaluate(() => {
    const { world, view } = window.sim;
    const camera = window.__labDisplay;
    const actors = [world.player, ...world.pursuit.patrols].map(actor => {
      const { root } = view.roots.get(actor.id);
      const point = root.position.clone(), edges = [];
      const { x, y, z } = root.position, yaw = root.rotation.y;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      for (const across of [-actor.width / 2, actor.width / 2]) {
        for (const along of [-actor.length / 2, actor.length / 2]) {
          for (const height of [0, (actor.height ?? 1.5) + .1]) {
            point.set(x + across * c + along * s, y + height, z + along * c - across * s).project(camera);
            edges.push([(point.x + 1) * innerWidth / 2, (1 - point.y) * innerHeight / 2]);
          }
        }
      }
      return { id: actor.id, left: Math.min(...edges.map(e => e[0])), right: Math.max(...edges.map(e => e[0])),
        top: Math.min(...edges.map(e => e[1])), bottom: Math.max(...edges.map(e => e[1])) };
    });
    const overlays = [".topbar", "#pursuitPanel", "#minimap"].map(selector =>
      document.querySelector(selector).getBoundingClientRect().toJSON());
    return { actors, overlays };
  });
  assert.equal(actors.length, 4);
  for (const bounds of actors) {
    assert.ok(bounds.left >= 0 && bounds.right <= 1365 && bounds.top >= 0 && bounds.bottom <= 900,
      `${bounds.id} is clipped by the Lab frame: ${JSON.stringify(bounds)}`);
    assert.ok(!overlays.some(overlay => bounds.left < overlay.right && bounds.right > overlay.left &&
      bounds.top < overlay.bottom && bounds.bottom > overlay.top),
    `${bounds.id} is hidden by the Lab HUD: ${JSON.stringify(bounds)}`);
  }
  return { actors, overlays };
}

async function chooseCase(caseId, learn = false) {
  const current = await read();
  if (current.phase === "running" || (current.phase !== "ready" && current.caseId === caseId))
    await id("pursuitRestartBtn").click();
  if (await id("packCase").inputValue() !== caseId) await id("packCase").selectOption(caseId);
  await wait(want => window.sim.world.pursuit?.caseId === want &&
    window.sim.world.pursuit.phase === "ready" && window.sim.view.actorDiagnostics().ready, caseId);
  if (learn) await id("pursuitLearn").check();
  else await id("pursuitLearn").uncheck();
  await observe();
}

async function observeImpactMotion() {
  await page.evaluate(() => {
    const world = window.sim.world, deadline = performance.now() + 6_000;
    const samples = window.__impactMotion = [];
    function sample(now) {
      if (window.sim.world !== world || now >= deadline) return;
      const { view } = window.sim;
      const impact = world.pursuit?.metrics.impact;
      const pose = impact && view.roots.get(impact.actorId)?.root.userData.pedestrianImpactPose;
      if (pose?.tick === impact?.tick && pose && Number.isFinite(pose.tiltRad)) {
        samples.push({ tick: world.tick, elapsed: world.tick - impact.tick, tiltRad: pose.tiltRad });
        if (world.tick - impact.tick >= 41) return;
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}

async function terminalPose(name) {
  await wait(() => window.sim.world.pursuit?.metrics.terminalCause &&
    window.sim.world.tick - window.sim.world.pursuit.metrics.impact.tick >= 41);
  const signal = await page.evaluate(() => {
    const { world, view } = window.sim, { metrics } = world.pursuit;
    const actor = world.actors.find(a => a.id === metrics.impact.actorId);
    const record = actor && view.roots.get(actor.id);
    const root = record?.root;
    let lowest = Infinity, vertices = 0;
    if (record?.visual?.visible) {
      const sample = root.position.clone();
      record.visual.traverse(part => {
        if (!part.isSkinnedMesh || !part.visible) return;
        const row = part.geometry.getAttribute("position");
        vertices += row.count;
        for (let i = 0; i < row.count; i++) {
          part.getVertexPosition(i, sample).applyMatrix4(part.matrixWorld);
          lowest = Math.min(lowest, sample.y - view.pedestrianGroundHeight(sample));
        }
      });
    }
    return { metrics, learning: world.pursuit.learner?.snapshot(),
      fallRad: root?.userData.pedestrianImpactPose?.tiltRad ?? 0,
      impact: actor?.impact ?? null, actor: actor?.type, audit: world.audit(),
      ground: { vertices, clearanceM: Number.isFinite(lowest) ? lowest : null },
      poseTimeline: window.__impactMotion };
  });
  await shot(name);
  assert.equal(signal.metrics.terminalCause, "pedestrian-impact");
  assert.equal(signal.metrics.pedestrianCollisions, 1);
  assert.ok(signal.metrics.penalty <= -220);
  assert.equal(signal.impact?.tick, signal.metrics.impact.tick);
  assert.ok(signal.poseTimeline.some(sample => sample.tiltRad < .55) &&
    signal.poseTimeline.some(sample => sample.tiltRad > .95), "The displayed body must lean before settling");
  assert.ok(signal.fallRad > .65, `Person has not changed pose after actual collision, ${JSON.stringify(signal)}`);
  assert.ok(signal.ground.vertices > 0 && signal.ground.clearanceM >= -.006 && signal.ground.clearanceM <= .10,
    `The hit pedestrian must rest above the road without clipping or floating: ${JSON.stringify(signal.ground)}`);
  assert.deepEqual(signal.audit, []);
  return signal;
}

async function turn() {
  await chooseCase("pack-dodge");
  await id("pursuitRunBtn").click();
  await id("aiToggleBtn").click();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowRight");
  try { await wait(() => window.__packEvidence.rows.length > 102 || window.sim.world.pursuit.phase !== "running"); }
  finally {
    await page.keyboard.up("ArrowRight");
    await page.keyboard.up("ArrowUp");
  }
  const numbers = await page.evaluate(() => {
    const rows = window.__packEvidence.rows, first = rows[0], a = first.heading;
    const lateralM = Math.max(...rows.map(r => Math.abs((r.x - first.x) * Math.cos(a) - (r.z - first.z) * Math.sin(a))));
    const angleRad = Math.max(...rows.map(r => Math.abs(r.heading - a)));
    const maxDelta = Math.max(...rows.slice(1).map((r, i) => Math.abs(r.steer - rows[i].steer)));
    return { lateralM, angleRad, maxDelta, rows };
  });
  assert.ok(numbers.lateralM >= 2.5 && numbers.angleRad >= Math.PI / 6 && numbers.maxDelta <= .016,
    `Actual turn missed physical limits: ${JSON.stringify({ ...numbers, rows: numbers.rows.length })}`);
  await shot("03-lab-evasive-arc");
  return numbers;
}

async function reverseLab() {
  await chooseCase("pack-crossing");
  await id("pursuitRunBtn").click();
  await id("aiToggleBtn").click();
  await page.keyboard.down("ArrowDown");
  try {
    await wait(() => window.__packEvidence.rows.some(row => row.speed < -1));
  } finally {
    await page.keyboard.up("ArrowDown");
  }
  const { rows } = await page.evaluate(() => ({ rows: window.__packEvidence.rows }));
  const rear = rows.find(row => row.speed < -1);
  assert.ok(rows.some(row => row.tick < rear.tick && Math.abs(row.speed) < .14) &&
    rows.some(row => row.tick < rear.tick && row.speed > 2), "Reverse must pass through a stopped pose");
  await shot("03b-lab-reverse");
  return { forwardMps: rows[0].speed, reverseMps: rear.speed, ticks: rear.tick - rows[0].tick };
}

async function cityTurn() {
  await resetCity("cairo-42");
  await id("pursuitLearn").uncheck();
  await id("packUseLabPolicy").uncheck();
  await id("pursuitLevel").selectOption("3");
  await observe();
  await id("pursuitRunBtn").click();
  await id("aiToggleBtn").click();
  await page.keyboard.down("ArrowUp");
  try {
    await wait(() => window.__packEvidence.rows.at(-1)?.elapsed >= 91);
    await page.keyboard.down("ArrowRight");
    try {
      await wait(() => {
        const { rows } = window.__packEvidence;
        const first = rows.find(row => row.elapsed >= 90), last = rows.at(-1);
        return first && (Math.abs(last.heading - first.heading) >= Math.PI / 6 &&
          Math.abs(last.z - first.z) >= 2.5 || last.elapsed >= 220 || last.phase !== "running");
      });
    } finally { await page.keyboard.up("ArrowRight"); }
  } finally { await page.keyboard.up("ArrowUp"); }
  const trace = await page.evaluate(() => window.__packEvidence.rows);
  const first = trace.find(row => row.elapsed >= 90);
  const result = {
    lateralM: Math.max(...trace.slice(trace.indexOf(first)).map(row => Math.abs(row.z - first.z))),
    headingRad: Math.max(...trace.slice(trace.indexOf(first)).map(row => Math.abs(row.heading - first.heading))),
    maxSteerStep: Math.max(...trace.slice(1).map((row, i) => Math.abs(row.steer - trace[i].steer))),
    trace,
  };
  assert.ok(result.lateralM >= 2.5 && result.headingRad >= Math.PI / 6 && result.maxSteerStep <= .016,
    `City trajectory: ${JSON.stringify({ ...result, trace: trace.length })}`);
  await shot("08c-city-evasive-arc");
  if (await id("pursuitRestartBtn").isVisible()) await id("pursuitRestartBtn").click();
  return result;
}

async function resetCity(seed, dense = false, crossing = false) {
  await id("settingsBtn").click();
  await page.locator('#settingsForm [name="seed"]').fill(seed);
  if (dense) {
    await page.locator('#settingsForm [name="speedLimit"]').fill("50");
    await page.locator('#settingsForm [name="difficulty"]').fill("5");
    await page.locator('#settingsForm [name="scenarioInterval"]').fill("2");
    await id("stressBtn").click();
  } else {
    if (crossing) {
      await page.locator('#settingsForm [name="traffic"]').fill("0");
      await page.locator('#settingsForm [name="pedestrians"]').fill("1");
    }
    await page.locator('#settingsForm button[type="submit"]').click();
  }
  await id("closeSettings").click();
  await wait(value => window.sim.world.config.seed === value && window.sim.view.actorDiagnostics().ready, seed);
}

async function measureTiming() {
  return await page.evaluate(() => new Promise(resolve => {
    const { sim } = window, start = performance.now(), initialTick = sim.world.tick;
    const render = sim.renderDiagnostics(), intervals = [];
    let previous = start, simEnd = null;
    const sample = now => {
      intervals.push(now - previous);
      previous = now;
      if (sim.world.pursuit.phase !== "running") simEnd ??= now;
      if (now - start < 4200 && !simEnd) return requestAnimationFrame(sample);
      const seconds = (now - start) / 1000;
      const frames = sim.renderDiagnostics().renderedFrames - render.renderedFrames;
      intervals.sort((a, b) => a - b);
      resolve({ fps: frames / seconds, hz: (sim.world.tick - initialTick) / seconds,
        p95: intervals[Math.ceil(intervals.length * .95) - 1], seconds, end: sim.world.pursuit.phase,
        population: sim.world.capacity, audit: sim.world.audit(),
        render: { width: render.width, height: render.height, dpr: render.pixelRatio,
          backend: render.backend, adapter: render.graphicsAdapter } });
    };
    requestAnimationFrame(sample);
  }));
}

// City contact samples use real registered pavement and the real step/guard.
// Initial actor poses are bounded and disclosed; no detector, hit event or UI is mocked.
async function armCityCross(impact) {
  await page.evaluate(impact => {
    const w = window.sim.world;
    const avenue = w.drivingRoads.find(road => road.id === "civic-avenue");
    const walker = w.actors.find(actor => actor.type === "pedestrian");
    const me = w.player, x = avenue.fixed - 2.5, z = -44;
    Object.assign(me, { x, z, heading: 0, steer: 0, speed: impact ? 6.8 : 5,
      path: [], previous: { x, z, heading: 0 } });
    const from = { x: x - (impact ? .44 : 1.7),
      z: z + (impact ? me.length / 2 + walker.radius + .25 : 8) };
    Object.assign(walker, from, { heading: Math.PI / 2, speed: 1.1, pause: 0, motionMode: "ambient",
      target: { x: avenue.fixed + avenue.width / 2 + 1.1, z: from.z }, road: avenue, crossing: true, walkSpeed: 1.5,
      district: { ...walker.district, caseId: "validation-crossing", stage: "moving",
        routeConstrained: false, holdAtTarget: true, yieldAtCurb: false } });
    walker.previous = { ...from, heading: walker.heading };
    const sweep = w.audit();
    if (sweep.length) throw new Error(`City validation start is not physically clear: ${sweep.join(", ")}`);
    window.__cityWalker = walker.id;
  }, impact);
}

try {
  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await id("labBtn").click();
  await id("streetPursuitBtn").click();
  await wait(() => window.sim.world.pursuit?.packLab && window.sim.view.actorDiagnostics().ready);
  report.order.push("lab");
  await chooseCase("pack-dodge", true);
  await observeLabFraming();
  await wait(() => Boolean(window.__labDisplay));
  report.lab.readyFraming = await assertLabFraming();
  await shot("01-lab-ready");
  await id("pursuitRunBtn").click();
  await wait(() => window.__packEvidence.rows.some(row => row.sectors >= 3 && row.closing >= 2));
  report.lab.activeFraming = await assertLabFraming();
  await shot("02-lab-pack-closing");
  await wait(() => window.sim.world.pursuit.learner.snapshot().updates >= 16 ||
    window.sim.world.pursuit.phase !== "running");
  await measurePack("lab");
  report.lab.turn = await turn();
  report.lab.reverse = await reverseLab();

  await chooseCase("pack-touch", true);
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.metrics.terminalCause === "police-touch");
  report.lab.touch = await read();
  assert.ok(report.lab.touch.metrics.impact.severity < .44 && report.lab.touch.metrics.penalty <= -100);
  assert.ok(report.lab.touch.learning.lastReward <= -100);
  await wait(() => /police|patrol/i.test(document.getElementById("packFeedback").textContent));
  assert.match(await id("packFeedback").innerText(), /police|patrol/i);
  await shot("04-lab-police-touch");

  await chooseCase("pack-crossing");
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit.metrics.firstYieldTick !== null);
  await wait(() => /yield/i.test(document.getElementById("packFeedback").textContent));
  await shot("05-lab-yield");
  await wait(() => {
    const m = window.sim.world.pursuit.metrics;
    return m.firstClearTick > m.firstYieldTick && m.distanceM > 10;
  });
  report.lab.clear = await read();
  assert.equal(report.lab.clear.metrics.pedestrianCollisions, 0);
  assert.equal(report.lab.clear.metrics.penalty, 0);
  assert.equal(report.lab.clear.posedPeople, 0);
  await wait(() => /clear|resum/i.test(document.getElementById("packFeedback").textContent));
  await shot("06-lab-crossing-clear");

  await chooseCase("pack-person-impact", true);
  await observeImpactMotion();
  await id("pursuitRunBtn").click();
  report.lab.impact = await terminalPose("07-lab-pedestrian-impact");
  assert.ok(report.lab.impact.learning.lastReward <= -220);
  const checkpoint = await page.evaluate(() => window.sim.world.pursuit.learner.checkpoint());
  assert.ok(Object.values(checkpoint.q).some(row => row.some(value => value !== 0)));

  await id("labBtn").click();
  report.order.push("city");
  await wait(() => window.sim.world.environment === "metro" && window.sim.view.actorDiagnostics().ready);
  await id("streetPursuitBtn").click();
  await id("pursuitStyle").selectOption("hunt");
  await id("pursuitLearn").uncheck();
  await id("packUseLabPolicy").check();
  await observe();
  await id("pursuitRunBtn").click();
  await wait(() => window.__packEvidence.rows.some(r => r.sectors >= 3 && r.closing >= 2));
  await shot("08-city-pack-closing");
  await wait(() => window.sim.world.tick - window.sim.world.pursuit.startedTick > 185 ||
    window.sim.world.pursuit.phase !== "running");
  const pack = await measurePack("city");
  await shot("08b-city-pack-backup");
  report.city.policy = await page.evaluate(checkpoint => {
    const { pursuit: p } = window.sim.world, rows = window.__packEvidence.rows;
    return { frozen: JSON.stringify(p.learner.checkpoint()) === JSON.stringify(checkpoint),
      source: p.driver, learning: p.learner.snapshot(),
      lookedUp: rows.filter(row => row.poly === "learned-tactical" || row.poly === "lab-policy").length,
      reinforcements: p.events.filter(event => event.kind === "reinforcement").map(event => event.tick - p.startedTick) };
  }, checkpoint);
  assert.equal(report.city.policy.source, "lab-policy");
  assert.ok(report.city.policy.frozen && report.city.policy.lookedUp > 0);
  assert.equal(report.city.policy.reinforcements[0], 180);
  assert.ok(report.city.policy.reinforcements.every(tick => tick % 180 === 0));
  if (await id("pursuitRestartBtn").isVisible() && await id("pursuitRestartBtn").isEnabled())
    await id("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.patrols.size === 0);
  assert.ok(pack.peakPolice > pack.peakSUV);
  const same = await page.evaluate(() => {
    const ev = window.__packEvidence, w = window.sim.world;
    return ev.world === w && ev.originals.every(actor => w.actors.includes(actor));
  });
  assert.equal(same, true);
  report.city.turn = await cityTurn();

  for (const impact of [false, true]) {
    await resetCity("pack-qa-city-cross", false, true);
    await id("pursuitLevel").selectOption("1");
    await id("packUseLabPolicy").uncheck();
    if (impact) await id("pursuitLearn").check();
    else await id("pursuitLearn").uncheck();
    await id("pauseBtn").click();
    await armCityCross(impact);
    if (impact) await observeImpactMotion();
    await id("pursuitRunBtn").click();
    if (impact) {
      report.city.impact = await terminalPose("10-city-pedestrian-impact");
      assert.equal(report.city.impact.learning.lastReward, report.city.impact.metrics.penalty);
    }
    else {
      await wait(() => {
        const p = window.sim.world.pursuit;
        return p.metrics.firstYieldTick > 0 && p.metrics.firstClearTick > p.metrics.firstYieldTick &&
          p.metrics.distanceM > 8;
      });
      report.city.clear = await read();
      assert.equal(report.city.clear.metrics.pedestrianCollisions, 0);
      assert.equal(report.city.clear.posedPeople, 0);
      await wait(() => /clear|resum/i.test(document.getElementById("packFeedback").textContent));
      await shot("09-city-crossing-clear");
      await id("pursuitRestartBtn").click();
    }
    await wait(() => window.sim.world.pursuit.patrols.size === 0 &&
      !window.sim.world.pursuit.reviewUntilTick && window.sim.world.mode === "manual");
  }
  await id("pursuitRunBtn").waitFor({ state: "visible" });
  await wait(() => !document.getElementById("pursuitRunBtn").disabled);
  await id("cameraOverlay").waitFor({ state: "visible" });
  const preview = await id("cameraOverlay").boundingBox(), cameraLabel = await id("cameraLabel").boundingBox();
  const drivingHud = await page.locator(".driving-hud").boundingBox();
  assert.ok(preview && cameraLabel && drivingHud && preview.y + preview.height + 8 <= drivingHud.y &&
    Math.abs(cameraLabel.y + cameraLabel.height - preview.y) <= 1,
  "The recovered viewport and its label must lie above the driving controls");
  report.city.recovered = { preview, cameraLabel, drivingHud };
  await shot("11-city-recovered");
  await resetCity("cairo-42", true);
  await id("pursuitLevel").selectOption("4");
  await id("pursuitLearn").uncheck();
  await id("pursuitRunBtn").click();
  report.city.dense = await measureTiming();
  assert.deepEqual(report.city.dense.population, { traffic: 96, pedestrians: 144 });
  const { width, height, dpr, backend } = report.city.dense.render;
  assert.deepEqual([width, height, dpr], [1365, 900, 1]);
  assert.match(backend, /WebGL/);
  assert.ok(report.city.dense.seconds >= 3 && report.city.dense.fps >= 25 &&
    report.city.dense.hz >= 45 && report.city.dense.p95 <= 75, JSON.stringify(report.city.dense));
  assert.deepEqual(report.city.dense.audit, []);
  await shot("12-city-max-density");
  await page.setViewportSize({ width: 900, height: 650 });
  await wait(() => window.sim.renderDiagnostics().width === 900);
  const hud = await id("pursuitPanel").boundingBox(), map = await id("minimap").boundingBox();
  assert.ok(hud && map && hud.y + hud.height <= map.y, "The compact pursuit HUD must not cover the map");
  await shot("13-city-compact");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack;
  await shot("failure");
  throw error;
} finally {
  await writeFile(join(output, "pack-report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
