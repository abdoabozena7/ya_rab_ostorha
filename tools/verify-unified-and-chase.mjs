import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  const candidates = ["playwright"];
  if (process.env.LOCALAPPDATA) {
    const cache = join(process.env.LOCALAPPDATA, "npm-cache", "_npx");
    if (existsSync(cache)) for (const dir of readdirSync(cache)) candidates.push(join(cache, dir, "node_modules", "playwright"));
  }
  let fallback;
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (existsSync(mod.chromium.executablePath())) return mod;
      fallback ??= mod;
    } catch {}
  }
  if (fallback) return fallback;
  throw new Error("Playwright not found; set PLAYWRIGHT_MODULE to the installed package path");
}
import { distance, overlaps, pointOnRoad } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { planTacticalInterceptAim, TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { SMART_ESCAPE_CONTROL } from "../src/rl/pako-smart-escape.js";
import { World } from "../src/core/world.js";

const output = process.env.PROVE_IT_OUTPUT_DIR || join(process.cwd(), "tmp", "verify-unified-and-chase");
const url = new URL(process.env.THREEJS_URL || "http://127.0.0.1:8769");
const sampleEvery = 15;
const blockerId = "verification-stopped-sedan";
const writeReport = (name, report) => writeFile(join(output, name), JSON.stringify(report, null, 2) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function getHealth() {
  const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(8000) });
  const health = await response.json();
  if (!response.ok || !health.ok || health.service !== "ya-rab-ostorha-threejs" ||
      health.mode !== "threejs" || health.externalSimulator !== false) {
    throw new Error(`Not a healthy standalone game: HTTP ${response.status} ${JSON.stringify(health)}`);
  }
  return health;
}

async function identifyBundle(bundleUrl) {
  const response = await fetch(bundleUrl, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!response.ok) throw new Error(`Browser bundle unavailable: HTTP ${response.status}`);
  const servedSha256 = hash(Buffer.from(await response.arrayBuffer()));
  const checkoutSha256 = hash(await readFile(new URL("../public/threejs/game.bundle.js", import.meta.url)));
  return { servedSha256, checkoutSha256, matches: servedSha256 === checkoutSha256 };
}

function normalTrial(disableUnifiedDriver) {
  const world = new World({ cityVersion: 5, seed: "king-long-vehicle-verification", traffic: 0, pedestrians: 0, chaos: 0,
    ...(disableUnifiedDriver ? { unifiedDriver: false } : {}) }, "metro");
  const { player } = world;
  const route = world.district.showcaseRoutes.find(({ start }) => start.roadId === "tahrir-boulevard");
  if (!world.command({ type: "destination", place: route.goal })) throw new Error("Tahrir destination rejected");
  const x = player.x + 100, z = player.path.find((p) => p.x >= x)?.z;
  const road = world.drivingRoads.find(({ id }) => id === route.start.roadId);
  if (!Number.isFinite(z) || !pointOnRoad({ x, z }, [road]) || Math.abs(z - player.z) > 0.2) {
    throw new Error("Stopped sedan would not block the routed Tahrir lane");
  }
  const blocker = world.makeVehicle(blockerId, "sedan", { x, z, heading: player.heading });
  Object.assign(blocker, { maxSpeed: 0, speed: 0, path: [] });
  world.actors.push(blocker);
  const initialDistance = player.distance, initialImpacts = player.vehicle.damage.impactCount;
  let lateralShiftM = 0, contacts = 0, stallTicks = 0, evasiveTicks = 0, passedBlocker = false;
  for (let i = 0; i < 2400; i++) {
    world.step();
    const gap = x - player.x;
    if (gap >= -8 && gap <= 40) lateralShiftM = Math.max(lateralShiftM, Math.abs(player.z - z));
    contacts += Number(overlaps(player, blocker));
    evasiveTicks += Number(player.reason === "evasive-shift");
    stallTicks = gap > 3 && gap < 18 && Math.abs(player.speed) < 0.1 ? stallTicks + 1 : 0;
    passedBlocker ||= gap < -(blocker.length + player.length) / 2;
    if (passedBlocker && !disableUnifiedDriver) break;
  }
  const collisions = player.vehicle.damage.impactCount - initialImpacts;
  const normalMode = world.mode === "auto" && !world.pursuit && !world.streetChaos?.active;
  if (!normalMode || distance(blocker, { x, z }) > 0.001 || blocker.speed !== 0) {
    throw new Error("Negative control did not keep its stationary sedan and normal-auto preconditions");
  }
  return { unifiedDriver: world.config.unifiedDriver !== false, roadId: road.id, destination: route.goal.id,
    ticks: world.tick, distanceM: player.distance - initialDistance, lateralShiftM, evasiveTicks, contacts, collisions,
    passedBlocker, stallTicks, gapM: x - player.x, finalSpeedMps: player.speed, completedTrips: world.metrics.completedTrips };
}

function fairnessTrial() {
  const source = new World({ seed: "tactical-zero-contact", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  source.command({ type: "street-pursuit-start", variant: "gta", level: 5, config: {
    ruleset: "dispatch-v1", wantedLevelStart: 5, wantedLevelMax: 5, maxActivePatrols: 14,
    curbSupport: METRO_CITY_CURBS, chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    tacticalPursuit: TACTICAL_PURSUIT_MODE, policeFairness: "city-fair-v1", surveillanceZones: [],
  } });
  const patrols = [...source.pursuit.patrols];
  const report = Object.freeze({ ...source.pursuit.response.lastSeen });
  if (!patrols.length || !Number.isFinite(report.x) || !Number.isFinite(report.z)) throw new Error("Missing real patrol or legal report");
  const cap = source.player.maxSpeed;
  function judge(planner, fleet) {
    let hiddenPlayerReads = 0;
    const world = Object.create(source, {
      player: { get() { hiddenPlayerReads++; return source.player; } },
      tick: { value: source.tick + 180 },
      pursuit: { value: { ...source.pursuit, response: { ...source.pursuit.response, unitsInContact: 0 } } },
    });
    const changedReport = { ...report, x: report.x + 250, z: report.z + 90 };
    const aims = fleet.map((car, slot) => planner(world, car, report, slot));
    const shifted = planner(world, fleet[0], changedReport, 0);
    const usesLegalReport = distance(aims[0], shifted) > 1;
    const faults = [];
    if (hiddenPlayerReads > 0) faults.push("hidden-player-read");
    if (!usesLegalReport || aims.some((aim) => aim.role !== "SEARCH" || aim.junctionIntercept ||
        !Number.isFinite(aim.x) || !Number.isFinite(aim.z))) faults.push("invalid-zero-contact-search");
    const speedViolations = fleet.filter((car) => !(car.maxSpeed <= cap && Math.abs(car.speed) <= cap)).map((car) => car.id);
    if (speedViolations.length) faults.push("patrol-speed-over-player-cap");
    return { passed: faults.length === 0, faults, unitsInContact: world.pursuit.response.unitsInContact, hiddenPlayerReads,
      usesLegalReport, roles: aims.map(({ role }) => role), sampleAim: aims[0], changedReportAim: shifted,
      maxPatrolSpeedMps: Math.max(...fleet.map(({ maxSpeed }) => maxSpeed)), playerMaxSpeedMps: cap, speedViolations };
  }
  const legal = judge(planTacticalInterceptAim, patrols);
  const hiddenPeek = judge((world, car, lastSeen, slot) => {
    const hidden = world.player;
    return planTacticalInterceptAim(world, car, { ...lastSeen, x: hidden.x, z: hidden.z }, slot);
  }, patrols);
  const overspeed = judge(planTacticalInterceptAim, [{ ...patrols[0], maxSpeed: cap + 1, speed: cap + 1 }, ...patrols.slice(1)]);
  return { legalReport: report, legal, hiddenPeek, overspeed };
}

async function negativeControl() {
  const report = { faultCaught: false, detectedFaults: [], execution: "paired isolated runs of the real Metro World and tactical planner" };
  try {
    if (process.env.THREEJS_URL) {
      report.server = { url: url.href, health: await getHealth(), bundle: await identifyBundle(new URL("/public/threejs/game.bundle.js", url)) };
      if (!report.server.bundle.matches) throw new Error("Live bundle does not match the checkout build");
    }
    const baseline = normalTrial(false), disabled = normalTrial(true);
    report.normalSelfDriving = { baseline, disabled };
    if (baseline.unifiedDriver && baseline.passedBlocker && baseline.distanceM >= 60 && baseline.lateralShiftM >= 0.6 &&
        baseline.collisions === 0 && baseline.contacts === 0 && !disabled.unifiedDriver && !disabled.passedBlocker &&
        disabled.stallTicks >= 180 && disabled.lateralShiftM < 0.5 && disabled.collisions === 0 && disabled.completedTrips === 0) {
      report.detectedFaults.push("NORMAL_SELF_DRIVING_STALLED_WITHOUT_UNIFIED");
    }
    const fairness = report.fairness = fairnessTrial();
    if (fairness.legal.passed && !fairness.hiddenPeek.passed && fairness.hiddenPeek.faults.includes("hidden-player-read") &&
        !fairness.overspeed.passed && fairness.overspeed.faults.includes("patrol-speed-over-player-cap")) {
      report.detectedFaults.push("UNFAIR_ZERO_CONTACT_OR_SPEED_BREACH");
    }
    report.faultCaught = report.detectedFaults.length === 2;
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeReport("negative-control.json", report);
  if (report.faultCaught) {
    console.error(`NEGATIVE_CONTROL_CAUGHT: ${report.detectedFaults.join(", ")}`);
    return 1;
  }
  console.error("Negative control did not demonstrate both required failures.", report.error ?? report.detectedFaults);
  return 2;
}

function installObserver({ sampleEvery, blockerId }) {
  const { world, view } = window.sim;
  const originalStep = world.step;
  const originalActors = new Set(world.actors);
  const lamps = world.statics.filter(({ kind }) => kind === "city-lamp");
  const roads = world.drivingRoads.filter((road) => !road.parkingBay && !road.supportApron);
  const angle = (n) => Math.atan2(Math.sin(n), Math.cos(n));
  const pose = ({ x, z, heading, speed, steer, width, length, distance, reason }) =>
    ({ x, z, heading, speed, steer, width, length, distance, reason });
  const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const relative = (p, target) => {
    const x = target.x - p.x, z = target.z - p.z;
    return { forwardM: x * Math.sin(p.heading) + z * Math.cos(p.heading),
      lateralM: x * Math.cos(p.heading) - z * Math.sin(p.heading), distanceM: Math.hypot(x, z) };
  };
  const hudOverlap = () => {
    const visible = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const bar = document.querySelector("#chaosBar");
    if (!visible(bar)) return 0;
    const leaves = [...bar.children].filter((el) => !el.matches(".chaos-bar__events"))
      .concat([...bar.querySelectorAll(".chaos-bar__events button")]).filter(visible).map((el) => el.getBoundingClientRect());
    let result = 0;
    for (let i = 0; i < leaves.length; i++) {
      const a = leaves[i];
      result += a.width * a.height - area(a, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      for (let j = i + 1; j < leaves.length; j++) result += area(a, leaves[j]);
    }
    const frame = bar.getBoundingClientRect();
    for (const other of document.querySelectorAll(".topbar, #chaseBar, #driveSense, #pursuitPanelHost, #inGamePhone, .driving-hud")) {
      if (visible(other) && !other.contains(bar)) result += area(frame, other.getBoundingClientRect());
    }
    return Math.max(0, result);
  };
  function currentRoad(p) {
    let id = null, best = Infinity;
    for (const road of roads) {
      const x = p.x - road.x1, z = p.z - road.z1;
      const along = road.axis === "x" ? p.x : road.axis === "z" ? p.z : x * road.ux + z * road.uz;
      const across = road.axis === "x" ? Math.abs(p.z - road.fixed) : road.axis === "z" ? Math.abs(p.x - road.fixed) :
        Math.abs(-x * road.uz + z * road.ux);
      if (along < (road.min ?? 0) || along > (road.max ?? road.length) || across > road.width / 2) continue;
      const axis = road.axis === "x" ? Math.PI / 2 : road.axis === "z" ? 0 : Math.atan2(road.ux, road.uz);
      const score = across / road.width + 2 * Math.abs(Math.sin(p.heading - axis));
      if (score < best) { id = road.id; best = score; }
    }
    return id;
  }
  function footprintsOverlap(a, b) {
    const x = b.x - a.x, z = b.z - a.z;
    const af = a.heading || 0, bf = b.heading || 0;
    const axes = [af, af + Math.PI / 2, bf, bf + Math.PI / 2];
    const support = (body, heading, axis) =>
      (body.length * Math.abs(Math.cos(axis - heading)) + body.width * Math.abs(Math.sin(axis - heading))) / 2;
    return axes.every((axis) => Math.abs(x * Math.sin(axis) + z * Math.cos(axis)) + 1e-5 <
      support(a, af, axis) + support(b, bf, axis));
  }
  function sweepLampIds(before, after, traveled) {
    const headingDelta = angle(after.heading - before.heading);
    const steps = Math.max(1, Math.ceil((traveled + Math.abs(headingDelta) * Math.hypot(after.length, after.width) / 2) / 0.05));
    const reach = 0.5 + Math.hypot(after.length, after.width) / 2;
    const local = lamps.filter((lamp) => Math.abs(lamp.x - before.x) <= reach + traveled && Math.abs(lamp.z - before.z) <= reach + traveled);
    if (!local.length) return [];
    const found = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: before.x + (after.x - before.x) * t, z: before.z + (after.z - before.z) * t,
        heading: before.heading + headingDelta * t, length: after.length, width: after.width };
      for (const lamp of local) if (footprintsOverlap(p, lamp)) found.add(lamp.id);
    }
    return [...found];
  }
  function patrolState() {
    return [...(world.pursuit?.patrols ?? [])].filter((a) => !["WRECKED", "DISABLED"].includes(a.aiState))
      .map((actor) => ({ id: actor.id, x: actor.x, z: actor.z, role: actor.squadRole, aiState: actor.aiState, speed: actor.speed,
        ...relative(world.player, actor) })).sort((a, b) => a.distanceM - b.distanceM);
  }
  const sample = () => ({ tick: world.tick, ego: pose(world.player), roadId: currentRoad(world.player),
    patrols: patrolState(), unitsInContact: world.pursuit?.response?.unitsInContact ?? null,
    driverDecisions: world.pursuit?.frozenDriver?.decisions ?? null, phase: world.pursuit?.phase ?? null });
  const impactCount = () => world.player.vehicle.damage.impactCount;
  let stats, obstacle;
  const begin = (mode) => {
    const initial = sample();
    stats = { mode, start: initial, last: initial, frames: [initial], headingMin: 0, headingMax: 0, headingUnwrapped: 0,
      lateralShiftM: 0, maxTickTravelM: 0, maxSteerDeltaRad: 0, maneuverTicks: 0, ticks: 0, lampSweepHits: [],
      lampPassThroughs: 0, lampCount: lamps.length, obstacleContacts: 0, passedBlocker: false, evasionTicks: 0,
      impactBaseline: impactCount(), hudOverlapPx: 0, firstChase: null, reactions: {} };
    return initial;
  };
  world.step = function (...args) {
    if (!stats || stats.mode === "chase" && world.pursuit?.phase !== "running" ||
        stats.mode === "cairo" && !world.streetChaos?.active) return originalStep.apply(this, args);
    if (stats.mode === "chase" && !stats.firstChase) {
      stats.firstChase = stats.start = sample();
      stats.frames = [stats.start];
      stats.impactBaseline = impactCount();
    }
    const before = pose(world.player), impacts = impactCount();
    const out = originalStep.apply(this, args);
    const after = pose(world.player), traveled = gap(before, after);
    stats.ticks++;
    stats.maxTickTravelM = Math.max(stats.maxTickTravelM, traveled);
    stats.maxSteerDeltaRad = Math.max(stats.maxSteerDeltaRad, Math.abs(after.steer - before.steer));
    for (const id of sweepLampIds(before, after, traveled)) {
      const reportedImpact = impactCount() > impacts;
      stats.lampSweepHits.push({ id, tick: world.tick, reportedImpact });
      if (!reportedImpact) stats.lampPassThroughs++;
    }
    stats.headingUnwrapped += angle(after.heading - before.heading);
    stats.headingMin = Math.min(stats.headingMin, stats.headingUnwrapped);
    stats.headingMax = Math.max(stats.headingMax, stats.headingUnwrapped);
    if (stats.mode === "normal" && obstacle) {
      const r = relative(stats.start.ego, after), obstacleStart = relative(stats.start.ego, obstacle);
      if (r.forwardM >= obstacleStart.forwardM - 40 && r.forwardM <= obstacleStart.forwardM + 8) {
        stats.lateralShiftM = Math.max(stats.lateralShiftM, Math.abs(r.lateralM - obstacleStart.lateralM));
        stats.evasionTicks += Number(after.reason === "evasive-shift");
      }
      stats.passedBlocker ||= r.forwardM > obstacleStart.forwardM + (after.length + obstacle.length) / 2;
      stats.obstacleContacts += Number(footprintsOverlap(after, obstacle));
    }
    if (stats.mode === "cairo") {
      const reason = world.streetChaos?.egoReaction?.reaction;
      if (reason) stats.reactions[reason] = (stats.reactions[reason] ?? 0) + 1;
    }
    stats.maneuverTicks += Number(Math.abs(after.steer) >= 0.04 && Math.abs(after.speed) > 1);
    if (stats.ticks % sampleEvery === 0) stats.frames.push(sample());
    return out;
  };
  window.__cityVerification = {
    sameCity: () => window.sim.world === world && window.sim.view === view &&
      [...originalActors].every((actor) => world.actors.includes(actor)),
    begin, sample,
    placeNormalStart() {
      const p = world.player;
      const road = roads.find(({ id }) => id === "tahrir-boulevard");
      const start = { ...pose(p), x: road.min + 25 };
      if (road.axis !== "x" || currentRoad(start) !== road.id || Math.abs(p.speed) > 0.001 ||
          [...world.statics, ...world.actors].some((body) => body !== p && footprintsOverlap(start, body))) {
        throw new Error("Clear west Tahrir mid-block fixture is unavailable");
      }
      Object.assign(p, { x: start.x, previous: { ...p.previous, x: start.x, z: p.z, heading: p.heading } });
      return { x: p.x, z: p.z, roadId: road.id, ambientActorsPreserved: true };
    },
    placeBlocker() {
      const { player } = world;
      const x = player.x + 70, z = player.path.find((p) => p.x >= x)?.z;
      if (!Number.isFinite(z) || Math.abs(z - player.z) > 0.3 || world.mode !== "auto" ||
          currentRoad(player) !== "tahrir-boulevard" || currentRoad({ x, z, heading: player.heading }) !== "tahrir-boulevard") {
        throw new Error("Phone route is not normal auto along Tahrir's initial lane");
      }
      obstacle = world.makeVehicle(blockerId, "sedan", { x, z, heading: player.heading });
      if (world.actors.some((a) => a.type === "vehicle" && gap(a, obstacle) < 5)) throw new Error("Stopped sedan fixture overlaps traffic");
      Object.assign(obstacle, { maxSpeed: 0, speed: 0, path: [] });
      world.actors.push(obstacle);
      return { id: obstacle.id, x, z, roadId: currentRoad(obstacle), leadM: x - player.x };
    },
    eraseBlocker() {
      if (obstacle) world.actors.splice(world.actors.indexOf(obstacle), 1);
      obstacle = null;
    },
    short() {
      const { player } = world;
      return { tick: world.tick, gapM: obstacle ? obstacle.x - player.x : null,
        lateralM: obstacle ? Math.abs(obstacle.z - player.z) : null, blockerSpeedMps: obstacle?.speed ?? null,
        started: stats?.firstChase, ticks: stats?.ticks, phase: world.pursuit?.phase, patrols: patrolState(),
        steer: player.steer, hudOverlapPx: hudOverlap(), requested: world.streetChaos?.request ?? null };
    },
    finish() {
      const last = sample(), samples = [...stats.frames];
      if (samples.at(-1).tick !== last.tick) samples.push(last);
      let previousRoad = null, sameSamples = 0;
      const roadIds = new Set();
      for (const { roadId } of samples) {
        sameSamples = roadId && roadId === previousRoad ? sameSamples + 1 : 1;
        if (roadId && sameSamples >= 3) roadIds.add(roadId);
        previousRoad = roadId;
      }
      const result = { ...stats, last, frames: samples, headingSpanRad: stats.headingMax - stats.headingMin,
        collisions: impactCount() - stats.impactBaseline, distanceM: last.ego.distance - stats.start.ego.distance,
        roadIds: [...roadIds], distinctRoads: roadIds.size, hudOverlapPx: hudOverlap() };
      stats = null;
      return result;
    },
    frame(scene) {
      const p = world.player, s = Math.sin(p.heading), c = Math.cos(p.heading);
      const eye = (back, right, y) => ({ x: p.x - back * s + right * c, y, z: p.z - back * c - right * s });
      if (scene === "cairo-exit") window.sim.setFreeCameraShot(null);
      else if (scene === "normal") window.sim.setFreeCameraShot({ pos: eye(11, 6, 8), lookAt: eye(-19, 0, 0.5), fov: 55 });
      else if (scene === "cairo") window.sim.setFreeCameraShot({ pos: eye(17, 7, 11), lookAt: eye(-22, 0, 0.8), fov: 55 });
      else window.sim.setFreeCameraShot({ pos: eye(26, 3, 21), lookAt: eye(-18, 0, 0.7), fov: 55 });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
  };
  return { environment: world.environment, cityVersion: world.config.cityVersion, ambientActors: originalActors.size - 1,
    lamps: lamps.length, vehicleModel: world.player.vehicleModel };
}

async function browserRun() {
  const report = { passed: false, pageErrors: 0, consoleErrors: [], errors: [], networkErrors: [], shots: [],
    normalSelfDriving: { passed: false }, cairoTraffic: { passed: false }, chasePressure: { passed: false },
    run: { url: url.href, sampleEveryTicks: sampleEvery, viewport: { width: 1280, height: 800 },
      execution: "live game UI and production World, paused rendering with fixed simulation steps between UI actions" } };
  let browser;
  try {
    report.run.health = await getHealth();
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true });
    report.run.browser = browser.version();
    const page = await browser.newPage({ viewport: report.run.viewport, deviceScaleFactor: 1 });
    page.setDefaultTimeout(25_000);
    page.on("pageerror", (error) => { report.pageErrors++; report.errors.push(error.stack ?? error.message); });
    page.on("console", (msg) => { if (msg.type() === "error") report.consoleErrors.push(msg.text()); });
    page.on("response", (response) => {
      if (response.status() >= 400) report.networkErrors.push(`HTTP ${response.status()} ${response.url()}`);
    });
    page.on("requestfailed", (request) => report.networkErrors.push(`${request.failure()?.errorText} ${request.url()}`));
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready, null, { timeout: 100_000 });
    await page.evaluate(() => window.sim.pause(true));
    console.log("Metro City ready; exercising live controls");
    const bundleUrl = await page.locator('script[src$="game.bundle.js"]').evaluate((script) => script.src);
    report.run.bundle = await identifyBundle(bundleUrl);
    report.run.city = await page.evaluate(installObserver, { sampleEvery, blockerId });
    if (!report.run.bundle.matches || report.run.city.cityVersion !== 5 || report.run.city.environment !== "metro" || !report.run.city.lamps) {
      throw new Error("Wrong build, city or missing solid lamps");
    }
    const observe = (method, argument) => page.evaluate(([method, argument]) => window.__cityVerification[method](argument), [method, argument]);
    const step = (count) => page.evaluate((count) => { window.sim.step(count); return window.__cityVerification.short(); }, count);
    const click = (id) => page.locator(`#${id}`).click();
    const versionOK = () => observe("sameCity");
    const pause = () => page.evaluate(() => window.sim.pause(true));
    const shot = async (name, camera) => {
      await observe("frame", camera);
      const sample = await observe("sample");
      const bytes = await page.screenshot({ path: join(output, name), timeout: 40_000 });
      const after = await observe("sample");
      if (sample.tick !== after.tick) throw new Error(`${name}: simulation tick changed during screenshot capture`);
      report.shots.push({ name, tick: sample.tick, camera, bytes: bytes.length, sha256: hash(bytes),
        ego: sample.ego, roadId: sample.roadId, nearbyPatrols: sample.patrols.filter(({ distanceM }) => distanceM <= 65) });
    };
    const stage = async (key, exercise) => {
      try { await exercise(report[key]); }
      catch (error) { report[key].error = error.stack ?? error.message; }
      console.log(`${key}: ${report[key].passed ? "PASS" : "FAIL"}${report[key].error ? ` ${report[key].error.split("\n")[0]}` : ""}`);
    };
    await stage("normalSelfDriving", async (result) => {
      // Fixed-tick observation isolates the Unified Driver from asynchronous camera-worker deadlines.
      await page.locator("#cityTools summary").click();
      await click("settingsBtn");
      await page.locator("#cityDriver").selectOption("sensors-only");
      await click("closeSettings");
      result.startFixture = await observe("placeNormalStart");
      await click("phoneToggleBtn");
      await page.locator("#inGamePhone").getByRole("button", { name: "الفرن البلدي", exact: true }).click();
      if (await page.locator("#inGamePhone").isVisible()) await click("phoneToggleBtn");
      result.blocker = await observe("placeBlocker");
      await observe("begin", "normal");
      console.log("Normal destination selected and stationary sedan placed on Tahrir");
      let frame = await observe("short");
      while (frame.ticks < 1050 && frame.gapM > 34) frame = await step(60);
      await shot("01-normal-self-driving-start.png", "normal");
      while (frame.ticks < 1500 && !(frame.gapM <= 13 && frame.lateralM >= 0.6)) frame = await step(30);
      await shot("02-normal-self-driving-avoid.png", "normal");
      while (frame.ticks < 1800 && frame.gapM >= -8) frame = await step(30);
      Object.assign(result, await observe("finish"));
      result.blockerStationary = frame.blockerSpeedMps === 0;
      result.normalAuto = await page.evaluate(() => {
        const { world } = window.sim;
        return world.mode === "auto" && world.visualMode === "sensors-only" && Boolean(world.destination) &&
          !world.pursuit && !world.streetChaos?.active;
      });
      result.sameCity = await versionOK();
      result.visualMode = await page.evaluate(() => window.sim.world.visualMode);
      result.passed = result.normalAuto && result.sameCity && result.blockerStationary && result.passedBlocker &&
        result.distanceM >= 60 && (result.lateralShiftM >= 0.6 || result.evasionTicks > 0) && result.maxTickTravelM <= 0.5 &&
        result.collisions === 0 && result.lampPassThroughs === 0 && result.obstacleContacts === 0;
    });
    await observe("eraseBlocker");
    await stage("cairoTraffic", async (result) => {
      const priorMode = await page.evaluate(() => window.sim.world.mode);
      await observe("begin", "cairo");
      await click("cairoChaosBtn");
      await pause();
      result.hudOpened = await page.locator("#chaosBar").isVisible();
      const opening = await page.evaluate(() => {
        const { world } = window.sim;
        return { truckCount: world.actors.filter(({ kind }) => kind === "truck").length,
          active: world.streetChaos?.active === true, driverMode: world.streetChaos?.driverMode };
      });
      Object.assign(result, opening);
      await step(60);
      await click("chaosTriggerGhorzBtn");
      let frame, overlap = 0;
      for (let i = 0; i < 10; i++) {
        frame = await step(45);
        overlap = Math.max(overlap, frame.hudOverlapPx);
        if (i === 3) await shot("03-cairo-traffic-unified.png", "cairo");
      }
      result.ghorzRequest = frame.requested;
      Object.assign(result, await observe("finish"));
      result.hudOverlapPx = Math.max(result.hudOverlapPx, overlap);
      result.collisions = Math.max(result.collisions, await page.evaluate(() => window.sim.world.streetChaos.metrics.collisions));
      await click("stopChaosBtn");
      result.cleanExit = !await page.locator("#chaosBar").isVisible() && await versionOK() && await page.evaluate((mode) => {
        const { world } = window.sim;
        return !world.streetChaos?.active && world.mode === mode && !world.pursuit;
      }, priorMode);
      await shot("04-cairo-traffic-exit.png", "cairo-exit");
      result.passed = result.hudOpened && result.active && result.driverMode === "auto" && result.truckCount >= 4 &&
        result.distanceM >= 10 && result.maxTickTravelM <= 0.5 && result.maxSteerDeltaRad <= 0.12 &&
        result.collisions === 0 && result.lampPassThroughs === 0 && result.hudOverlapPx === 0 && result.cleanExit;
    });
    await stage("chasePressure", async (result) => {
      result.vehicle = await page.evaluate(() => {
        const { world } = window.sim;
        world.command({ type: "stop" });
        for (let i = 0; i < 360 && Math.abs(world.player.speed) > 1e-5; i++) window.sim.step(1);
        return window.sim.carAction("player-vehicle", "jetour-t2");
      });
      if (!result.vehicle?.ok) throw new Error(`Could not switch to Jetour T2: ${JSON.stringify(result.vehicle)}`);
      await click("pakoBtn");
      await page.locator("#pursuitLevel").selectOption("5");
      await observe("begin", "chase");
      await click("pursuitRunBtn");
      await pause();
      if (!(await observe("short")).started) await step(1);
      const first = await observe("short");
      if (!first.started) throw new Error("Real Chase UI did not start a running Chase");
      const opening = first.started.patrols.filter(({ distanceM }) => distanceM <= 65);
      result.openingWithin65m = opening.length;
      result.openingForward = opening.filter(({ forwardM }) => forwardM > 0).length;
      await shot("05-chase-opening-police-pack.png", "chase");
      let frame = first, captured = false;
      while (frame.ticks < 1350 && frame.phase === "running") {
        frame = await step(Math.min(60, 1350 - frame.ticks));
        const close = frame.patrols.filter(({ distanceM }) => distanceM <= 55);
        if (!captured && frame.ticks >= 120 && close.length >= 2 && close.some(({ forwardM }) => forwardM > 3)) {
          await shot("06-chase-tactical-intercept.png", "chase");
          captured = true;
        }
      }
      if (!captured) await shot("06-chase-tactical-intercept.png", "chase");
      Object.assign(result, await observe("finish"));
      const chase = await page.evaluate(() => {
        const { world } = window.sim, run = world.pursuit;
        return { level: run?.level, wantedLevelAtEnd: run?.wantedLevel, collisionCounter: run?.metrics?.collisions,
          pedestrianCollisions: run?.metrics?.pedestrianCollisions, model: world.player.vehicleModel ?? "jetour-t2",
          controller: run?.frozenDriver?.evasiveControl, status: run?.frozenDriver?.status,
          policySha256: run?.frozenDriver?.sha256, decisions: run?.frozenDriver?.decisions };
      });
      result.driver = chase;
      result.collisions = Math.max(result.collisions, chase.collisionCounter ?? 0, chase.pedestrianCollisions ?? 0);
      result.peakWithin55m = Math.max(...result.frames.map(({ patrols }) => patrols.filter(({ distanceM }) => distanceM <= 55).length));
      result.minimumPatrolDistanceM = Math.min(...result.frames.flatMap(({ patrols }) => patrols.map(({ distanceM }) => distanceM)));
      const intercept = report.shots.at(-1).nearbyPatrols.filter(({ distanceM }) => distanceM <= 55);
      result.interceptFrameNear = intercept.length;
      result.interceptFrameForward = intercept.filter(({ forwardM }) => forwardM > 3).length;
      if (await page.locator("#stopChaseBtn").isVisible()) await click("stopChaseBtn");
      else await click("selfDrivingBtn");
      result.cleanExit = await versionOK() && !await page.locator("#chaseBar").isVisible() && await page.evaluate(() => {
        const { world } = window.sim;
        return world.pursuit?.phase !== "running" && !world.actors.some((actor) => actor.type === "police" || actor.team === "patrol");
      });
      result.passed = chase.level === 5 && chase.model === "jetour-t2" && chase.status === "active" &&
        chase.controller === SMART_ESCAPE_CONTROL && chase.decisions > 0 && result.ticks >= 1200 &&
        result.openingWithin65m >= 3 && result.openingForward >= 1 && result.peakWithin55m >= 2 &&
        result.interceptFrameNear >= 2 && result.interceptFrameForward >= 1 &&
        (result.headingSpanRad >= 0.35 || result.distinctRoads >= 2) && result.collisions === 0 &&
        result.lampPassThroughs === 0 && result.cleanExit;
    });
  } catch (error) {
    report.errors.push(error.stack ?? error.message);
  } finally {
    await browser?.close().catch((error) => report.errors.push(error.message));
  }
  report.passed = report.pageErrors === 0 && !report.consoleErrors.length && !report.errors.length && !report.networkErrors.length &&
    report.shots.length >= 6 && [report.normalSelfDriving, report.cairoTraffic, report.chasePressure].every(({ passed }) => passed);
  await writeReport("live-report.json", report);
  console.log(`Live Metro verification ${report.passed ? "PASS" : "FAIL"}: ${join(output, "live-report.json")}`);
  return report.passed ? 0 : 1;
}

await mkdir(output, { recursive: true });
switch (process.argv[2]) {
  case "negative-control": process.exitCode = await negativeControl(); break;
  case "browser": process.exitCode = await browserRun(); break;
  default: console.error("Usage: node tools/verify-unified-and-chase.mjs <negative-control|browser>"); process.exitCode = 2;
}
