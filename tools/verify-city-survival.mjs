import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: url, CITY_SURVIVAL_PREVIOUS: previous } = process.env;
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(18_000);
const report = { errors: [] };
const id = value => page.locator(`#${value}`);
const shot = name => page.screenshot({ path: join(output, `${name}.png`) });
const wait = (fn, arg) => page.waitForFunction(fn, arg);
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
page.on("response", response => { if (response.status() >= 400) report.errors.push(response.url()); });

await page.addInitScript(() => {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (output, ...args) {
    if (output === this.context.destination && this instanceof DynamicsCompressorNode) {
      const meter = this.context.createAnalyser();
      meter.fftSize = 1024;
      connect.call(this, meter);
      const pcm = new Float32Array(meter.fftSize);
      window.__pursuitRms = () => {
        meter.getFloatTimeDomainData(pcm);
        return Math.sqrt(pcm.reduce((sum, sample) => sum + sample ** 2, 0) / pcm.length);
      };
    }
    return connect.call(this, output, ...args);
  };
});

async function ready() {
  await wait(() => window.sim?.view.actorDiagnostics().ready);
}

async function setupCity(config) {
  await page.evaluate(config => {
    const sim = window.sim;
    sim.pause(true);
    if (config) sim.reset({ seed: "cairo-42", ...config });
  }, config);
  await ready();
  if (!(await id("pursuitPanel").isVisible())) await id("streetPursuitBtn").click();
  assert.equal(await id("pursuitStyle").inputValue(), "survival");
}

async function start() {
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.variant === "survival" && window.sim.world.pursuit.phase === "running");
}

const bearingDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const readPose = target => target.evaluate(() => {
  const { player, tick, pursuit: p } = window.sim.world;
  const { x, z, speed, heading, steer, arcadeSlip } = player;
  return { x, z, speed, heading, steer, arcadeSlip, tick, elapsed: tick - p.startedTick };
});

async function stockScene() {
  await setupCity(null);
  assert.equal(await id("garageBtn").count(), 0, "The production app must not launch a standalone Garage");
  assert.equal(await id("environmentLabel").textContent(), "City");
  await page.evaluate(() => {
    const { world, view } = window.sim;
    const { roadGraph, roads, statics, player, actors, tick } = world;
    const prepare = view.prepareFrame;
    const retained = window.__realCity = { world, view, scene: view.scene, roadGraph, roads, statics,
      player, rig: view.playerRig.root, actors: actors.map(actor => ({ actor, x: actor.x, z: actor.z })),
      tick, rendered: 0 };
    view.prepareFrame = function (...args) {
      if (window.sim.world.pursuit?.phase === "running") retained.rendered++;
      return prepare.apply(this, args);
    };
  });
  await shot("01-city-before-pursuit");
  await start();
  const opening = await page.evaluate(() => {
    const { world, view } = window.sim, { pursuit: p } = world;
    return { selectedDriver: world.mode, spawned: p.survival.spawnCount, rigs: p.patrols.size,
      stillSameView: view === window.__realCity.view };
  });
  assert.deepEqual(opening, { selectedDriver: "auto", spawned: 2, rigs: 2, stillSameView: true });
  await wait(() => {
    const { world } = window.sim, p = world.pursuit;
    return p.phase === "running" && p.metrics.distanceM >= 4 &&
      world.tick - p.startedTick >= 90 && window.__realCity.rendered > 2;
  });
  report.identity = await page.evaluate(() => {
    const { world, view } = window.sim, old = window.__realCity;
    const moved = ({ actor, x, z }) => Math.hypot(actor.x - x, actor.z - z) > .25;
    return { sameWorld: world === old.world, sameScene: view.scene === old.scene, sameView: view === old.view,
      sameSurface: world.roads === old.roads && world.statics === old.statics,
      sameSuv: world.player === old.player && view.playerRig.root === old.rig,
      originals: old.actors.every(({ actor }) => world.actors.includes(actor)), cityTicks: world.tick - old.tick,
      ambientDrivers: old.actors.filter(p => p.actor.type === "vehicle" && p.actor !== old.player && moved(p)).length,
      ambientWalkers: old.actors.filter(p => p.actor.type === "pedestrian" && moved(p)).length,
      renderedFrames: old.rendered, distanceM: world.pursuit.metrics.distanceM,
      arcadeLayerIsChild: Boolean(old.scene.getObjectByName("city-pursuit-effects")), audit: world.audit() };
  });
  const i = report.identity;
  assert.ok(i.sameWorld && i.sameView && i.sameScene && i.sameSurface && i.sameSuv && i.originals && i.arcadeLayerIsChild);
  assert.ok(i.ambientDrivers > 0 && i.ambientWalkers > 0 && i.cityTicks > 15);
  assert.deepEqual(i.audit, []);
  await shot("02-same-city-opening");
  const on = await (await wait(() => {
    const rms = window.__pursuitRms?.();
    return rms > .005 ? rms : false;
  })).jsonValue();
  await id("pursuitSound").click();
  await wait(() => window.sim.pursuitAudio().muted && window.__pursuitRms?.() < .001);
  report.audio = { signalRms: on, mutedRms: await page.evaluate(() => window.__pursuitRms()) };
  await wait(() => window.sim.world.pursuit.survival.active?.kind === "giant" &&
    document.getElementById("pursuitPowerLabel").textContent.includes("Giant"));
  assert.ok(await page.evaluate(() => {
    const { roots, playerRig } = window.sim.view;
    return playerRig.root.parent === roots.get("player").root && playerRig.root.parent.scale.x > 1.3;
  }));
  await shot("03-city-giant");
  await impactAndRetry();
}

async function impactAndRetry() {
  await wait(() => window.sim.world.pursuit?.reviewUntilTick);
  const begin = await page.evaluate(() => {
    const { world, view } = window.sim, old = window.__realCity, s = world.pursuit;
    const now = performance.now();
    window.__pursuitImpact = { s, x: world.player.x, z: world.player.z };
    return { now, reviewedOnOriginalScene: old.scene === view.scene && world === old.world,
      time: s.metrics.survivalS, impact: s.metrics.terminalCause };
  });
  assert.ok(begin.reviewedOnOriginalScene && begin.impact);
  await wait(() => window.sim.world.tick > window.sim.world.pursuit.endedTick + 6);
  await shot("06-same-city-impact");
  await wait(() => !window.sim.world.pursuit.reviewUntilTick);
  const finished = await page.evaluate(begin => {
    const p = window.sim.world.pursuit;
    return { wallS: (performance.now() - begin.now) / 1000, score: p.metrics.survivalS };
  }, begin);
  assert.equal(finished.score, begin.time);
  assert.ok(finished.wallS >= .6);
  await wait(() => document.getElementById("pursuitRunBtn").textContent === "Run again" &&
    !document.getElementById("pursuitRunBtn").disabled);
  await shot("07-city-result");
  const best = await id("pursuitBest").textContent();
  assert.notEqual(best, "—");
  await page.keyboard.press("KeyR");
  await wait(() => window.sim.world.pursuit?.phase === "running" &&
    window.sim.world.pursuit !== window.__pursuitImpact.s);
  const retry = await page.evaluate(() => {
    const { world, view } = window.sim, old = window.__realCity, strike = window.__pursuitImpact;
    return { retryInPlace: old.world === world && old.scene === view.scene && old.player === world.player &&
      old.statics === world.statics && old.actors.every(p => world.actors.includes(p.actor)) &&
      Math.hypot(world.player.x - strike.x, world.player.z - strike.z) < 1.5,
    elapsed: world.pursuit.metrics.survivalS };
  });
  assert.ok(retry.retryInPlace && retry.elapsed < .4);
  await id("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "stopped");
  assert.ok(await page.evaluate(() => {
    const { world, view } = window.sim, old = window.__realCity;
    return old.world === world && old.scene === view.scene && old.player === world.player &&
      old.actors.every(p => world.actors.includes(p.actor)) && world.actors.length === old.actors.length &&
      world.player.width === world.pursuit.survival.footprint.width && world.audit().length === 0;
  }));
  await page.reload();
  await ready();
  await id("streetPursuitBtn").click();
  assert.equal(await id("pursuitBest").textContent(), best);
  report.impact = { retryInPlace: true, reviewWallS: finished.wallS, score: finished.score,
    cause: begin.impact, restoredBest: best };
}

async function pressure() {
  // Use the real City and stock autopilot with a clear traffic setting to let the later wave develop.
  await setupCity({ traffic: 0, pedestrians: 0 });
  await start();
  if (await id("pursuitSound").getAttribute("aria-pressed") !== "true") await id("pursuitSound").click();
  const pileup = await (await wait(() => {
    const { world, view } = window.sim, s = world.pursuit;
    const real = s.survival.effects.filter(e => e.type === "wreck" && e.reason === "patrol");
    const last = real.at(-1), previous = real.at(-2);
    if (!last || !previous || last.tick !== previous.tick || world.tick < last.tick + 9) return false;
    const distance = Math.hypot(last.x - world.player.x, last.z - world.player.z);
    const layer = view.scene.getObjectByName("city-wreck-smoke");
    return { ids: [previous.actorId, last.actorId], distance, visibleSmokeInstances: layer?.count ?? 0,
      count: s.survival.wrecks.size, tick: last.tick - s.startedTick };
  })).jsonValue();
  report.stockPileup = pileup;
  assert.ok(pileup.count >= 2 && pileup.visibleSmokeInstances > 0, JSON.stringify(pileup));
  await page.waitForFunction(() => [...window.sim.world.pursuit.patrols].some(p => p.pursuitUnit === "heavy" &&
    p.distance > 3 && Math.hypot(p.x - window.sim.world.player.x, p.z - window.sim.world.player.z) < 26),
  null, { timeout: 36_000 });
  await shot("05-city-heavy-backup");
  report.wave = await page.evaluate(pileup => {
    const { world } = window.sim, s = world.pursuit, a = s.survival;
    const heavy = [...s.patrols].filter(p => p.pursuitUnit === "heavy");
    return { pileup, spawned: a.spawnCount, local: s.patrols.size, elapsed: s.metrics.survivalS,
      sectors: new Set(a.effects.filter(e => e.type === "dispatch").map(e => e.sector)).size,
      heavy: heavy.map(p => ({ kind: p.kind, distance: p.distance, width: p.width, length: p.length })),
      audit: world.audit() };
  }, pileup);
  assert.ok(report.wave.spawned >= 10 && report.wave.sectors >= 2 && report.wave.elapsed < 25 &&
    report.wave.heavy.some(p => p.kind === "van" && p.length > 5 && p.distance > 3));
  assert.deepEqual(report.wave.audit, []);
  if (await id("pursuitRestartBtn").isVisible()) await id("pursuitRestartBtn").click();
}

async function nearbyPileup() {
  await setupCity({ traffic: 0, pedestrians: 0 });
  await start();
  await page.evaluate(() => {
    const sim = window.sim, { world } = sim, s = world.pursuit, p = world.player;
    sim.pause(true);
    const [a, b] = s.patrols;
    const along = Math.sin(p.heading), forward = Math.cos(p.heading);
    for (const [car, offset, heading] of [[a, 11, p.heading], [b, 11 + a.length / 2 + b.length / 2 + .09, p.heading + Math.PI]]) {
      Object.assign(car, { x: p.x + along * offset, z: p.z + forward * offset, heading, speed: 9, path: [] });
      car.pursuitDrive.nextPlan = Infinity;
    }
    if (world.audit().length) throw new Error("Controlled patrol approaches must start on clear, non-overlapping city pavement");
    sim.pause(false);
  });
  const wrecks = await (await wait(() => {
    const { world, view } = window.sim, s = world.pursuit;
    const wrecks = [...s.survival.wrecks.keys()];
    const smoke = view.scene.getObjectByName("city-wreck-smoke")?.count ?? 0;
    const event = s.survival.effects.find(e => e.type === "wreck" && e.reason === "patrol");
    return event && world.tick >= event.tick + 14 && smoke > 0 && wrecks.length === 2 && {
      count: wrecks.length, stopped: wrecks.every(car => car.speed === 0 && world.actors.includes(car)),
      distance: Math.hypot(event.x - world.player.x, event.z - world.player.z), smoke, audit: world.audit(),
    };
  })).jsonValue();
  assert.ok(wrecks.stopped && wrecks.distance < 18);
  assert.deepEqual(wrecks.audit, []);
  await shot("04-city-patrol-pileup");
  report.nearbyPileup = wrecks;
  await id("pursuitRestartBtn").click();
}

async function controlledPower(kind) {
  await setupCity({ traffic: 0, pedestrians: 0 });
  await start();
  await page.keyboard.press("KeyI");
  const origin = await page.evaluate(kind => {
    const { world } = window.sim, p = world.player, s = world.pursuit;
    const ord = world.actors.filter(actor => !s.patrols.has(actor));
    world.actors.splice(0, world.actors.length, ...ord);
    s.patrols.clear();
    s.nextDispatchTick = Infinity;
    const sx = Math.sin(p.heading), sz = Math.cos(p.heading);
    s.survival.pickup = { x: p.x + sx * .5, z: p.z + sz * .5, kind, until: world.tick + 150 };
    if (kind === "ghost") {
      const prop = { x: p.x + sx * 5, z: p.z + sz * 5, heading: p.heading,
        id: "verification-city-road-prop", kind: "barrier", type: "static", width: 2.4, length: .45, height: .65 };
      world.statics = world.statics.concat(prop);
      world.staticIndex = new world.staticIndex.constructor(world.statics);
    }
    return { x: p.x, z: p.z, sx, sz };
  }, kind);
  if (kind === "ghost") {
    const cross = args => {
      const { player, pursuit } = window.sim.world;
      const along = (player.x - args.x) * args.sx + (player.z - args.z) * args.sz;
      return pursuit.phase === "running" && pursuit.survival.active?.kind === "ghost" && along > args.min && { along };
    };
    await wait(cross, { ...origin, min: 4.65 });
    await shot("08-city-ghost-on-existing-road");
    report.powers.ghost = await (await wait(cross, { ...origin, min: 8 })).jsonValue();
  } else {
    await wait(which => document.getElementById("pursuitFire").textContent.includes(which) &&
      !document.getElementById("pursuitFire").disabled, kind === "mine" ? "Mine" : "Pulse");
    const before = await readPose(page);
    if (kind === "mine") await id("pursuitFire").click();
    else await page.keyboard.press("KeyE");
    const effect = await (await wait(kind => {
      const { survival } = window.sim.world.pursuit;
      const hit = survival.effects.find(e => e.type === "use" && e.kind === kind);
      return survival.held === null && hit;
    }, kind)).jsonValue();
    const metreOffset = (effect.x - before.x) * origin.sx + (effect.z - before.z) * origin.sz;
    assert.ok(kind === "mine" ? metreOffset < -2 : metreOffset > 2);
    report.powers[kind] = { metres: metreOffset, spent: true };
  }
  await id("pursuitRestartBtn").click();
}

async function portraitDrift() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    hasTouch: true, isMobile: true });
  try {
    const phone = await context.newPage();
    phone.on("pageerror", error => report.errors.push(error.message));
    await phone.goto(url);
    await phone.waitForFunction(() => window.sim?.view.actorDiagnostics().ready);
    await phone.evaluate(() => { window.sim.pause(true); window.sim.reset({ seed: "cairo-42", traffic: 0, pedestrians: 0 }); });
    await phone.locator("#streetPursuitBtn").tap();
    await phone.locator("#pursuitRunBtn").tap();
    await phone.locator("#aiToggleBtn").tap();
    await phone.waitForFunction(() => window.sim.world.mode === "manual" &&
      window.sim.world.player.speed > 4);
    const client = await context.newCDPSession(phone);
    const turn = async (selector, direction) => {
      const button = phone.locator(selector);
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
        bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844 && bounds.height >= 44);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{
        x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
      }] });
      await phone.waitForFunction(steer => window.sim.world.pursuit.manualAction.steer === steer, direction);
      const before = await readPose(phone);
      await phone.waitForFunction(tick => window.sim.world.tick >= tick + 24, before.tick);
      const after = await readPose(phone);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await phone.waitForFunction(() => window.sim.world.pursuit.manualAction.steer === 0 &&
        Math.abs(window.sim.world.player.steer) < .05);
      const sideM = (after.x - before.x) * Math.cos(before.heading) - (after.z - before.z) * Math.sin(before.heading);
      return { changed: bearingDelta(after.heading, before.heading), sideM, slip: after.arcadeSlip };
    };
    const left = await turn("#pursuitTouchLeft", 1), right = await turn("#pursuitTouchRight", -1);
    report.portrait = { viewport: "390x844", left, right };
    await phone.screenshot({ path: join(output, "09-city-touch-drift.png") });
    assert.ok(left.changed > .08 && right.changed < -.08 && Math.abs(left.slip) > .06 && Math.abs(left.sideM) > .12,
      JSON.stringify(report.portrait));
  } finally {
    await context.close();
  }
}

try {
  if (previous) {
    for (const [pathname, file] of [["/", "index.html"], ["/public/threejs/game.bundle.js", "game.bundle.js"],
      ["/public/threejs/game.styles.css", "game.styles.css"]]) {
      await page.route(url + pathname.slice(1), route => route.fulfill({ path: join(previous, file) }));
    }
  }
  await page.goto(url);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  if (previous) {
    assert.equal(await id("environmentLabel").textContent(), "City");
    await id("garageBtn").click();
    const cityTick = await page.evaluate(() => window.sim.world.tick);
    await id("garageLaunch").click();
    await wait(() => window.sim.garage.tick > 22);
    report.original = await page.evaluate(tick => ({
      cityTicks: window.sim.world.tick - tick, separateTicks: window.sim.garage.tick,
    }), cityTick);
    await shot("old-separate-scene");
    assert.ok(report.original.cityTicks > 15, "The original City world must keep ticking while the chase is playing");
  } else {
    await stockScene();
    await pressure();
    await nearbyPileup();
    report.powers = {};
    for (const kind of ["ghost", "mine", "pulse"]) await controlledPower(kind);
    await portraitDrift();
    assert.deepEqual(report.errors, []);
  }
} finally {
  await writeFile(join(output, "city-survival.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
