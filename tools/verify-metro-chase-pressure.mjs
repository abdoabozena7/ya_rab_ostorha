import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, argument] = process.argv.slice(2);
const target = new URL(url);
assert.ok(target.protocol === "http:" && target.hostname === "127.0.0.1", "Pass an owned City loopback URL");
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory");
const expectedPolicy = createHash("sha256").update(await readFile(
  new URL("../public/threejs/pako-chase-ppo.json", import.meta.url))).digest("hex");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const negative = argument === "--unprofiled";
const routeMemory = argument === "--route-memory";
const report = { engine: "live standalone Metro; browser loop with explicit fixed-step sampling", negative, errors: [] };
const browser = await chromium.launch({ headless: false });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(25000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== "/favicon.ico")
      report.errors.push(`${response.status()} ${response.url()}`);
  });
  const wait = (fn, value) => page.waitForFunction(fn, value, { timeout: 30000 });
  const id = name => page.locator(`#${name}`);
  const shot = name => page.screenshot({ path: join(output, name), animations: "disabled" });

  const health = await page.request.get(new URL("/api/health", target).href);
  assert.equal((await health.json()).externalSimulator, false);
  await page.goto(url);
  await wait(() => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready);
  await page.evaluate(negative => {
    const sim = window.sim;
    sim.reset(sim.world.config);
    sim.pause(true);
    const { world, view } = sim;
    window.chaseWitness = {
      world, view, player: world.player, actors: [...world.actors],
      peopleSeen: new Set(), trafficSeen: new Set(), movedRadio: new Set(),
      patrolPoses: new Map(), relaySamples: 0, overlapSamples: 0,
      contactSamples: 0, peakMobileLocal: 0, safetyActions: 0, nitroViolations: 0,
      maxPatrolStepM: 0, trace: [],
    };
    if (negative) {
      const command = world.command;
      world.command = function (event, ...rest) {
        if (event.type === "street-pursuit-start") {
          const { cityPackPressure, routeMemory, ...config } = event.config;
          return command.call(this, { ...event, config }, ...rest);
        }
        return command.call(this, event, ...rest);
      };
    }
  }, negative);
  await wait(() => window.sim.view.actorDiagnostics().ready);
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("5");
  assert.match(await id("pursuitScene").textContent(), /RL PPO/);
  const begin = async () => {
    await id("pursuitRunBtn").click();
    await wait(() => window.sim.world.pursuit?.phase === "running");
    await page.evaluate(() => window.sim.pause(true));
  };
  await begin();
  report.opening = await page.evaluate(() => {
    const { world, view } = window.sim, witness = window.chaseWitness;
    const { player, pursuit } = world;
    const patrols = [...pursuit.patrols];
    witness.patrols = patrols;
    const near = patrols.filter(unit => Math.hypot(unit.x - player.x, unit.z - player.z) <= 65);
    const sectors = new Set(near.map(unit => {
      const bearing = Math.atan2(unit.x - player.x, unit.z - player.z) - player.heading;
      return (Math.round(bearing / (Math.PI / 2)) + 8) % 4;
    }));
    return {
      environment: world.environment, tick: world.tick, startedTick: pursuit.startedTick,
      profile: pursuit.gta.config.cityPackPressure ?? null, vehicle: player.vehicleModel,
      routeMemory: pursuit.gta.config.routeMemory ?? null,
      driver: pursuit.frozenDriver?.sha256, activePatrols: patrols.length,
      nearbyPatrols: near.length, approachSectors: sectors.size,
      traffic: world.capacity.traffic, people: world.capacity.pedestrians,
      sameCity: world === witness.world && view === witness.view && player === witness.player,
      keepsCivilians: witness.actors.every(actor => world.actors.includes(actor)),
      patrolSpeedCapped: patrols.every(unit => unit.maxSpeed <= player.maxSpeed),
    };
  });
  assert.equal(report.opening.environment, "metro");
  if (routeMemory) assert.equal(report.opening.routeMemory, "observed-corridor-memory-v1");
  assert.equal(report.opening.driver, expectedPolicy);
  assert.ok(report.opening.sameCity && report.opening.keepsCivilians && report.opening.patrolSpeedCapped);
  assert.ok(report.opening.traffic >= 68 && report.opening.people >= 190);
  assert.ok(report.opening.activePatrols >= 12);
  await shot("chase-opening.png");

  for (let chunk = 0; chunk < 9; chunk++) {
    await page.evaluate(chunk => {
      const sim = window.sim, { world } = sim, s = world.pursuit, ego = world.player;
      const tracker = window.chaseWitness;
      const target = s.startedTick + (chunk + 1) * 120;
      while (s.phase === "running" && world.tick < target) {
        sim.step(Math.min(6, target - world.tick));
        const range = p => Math.hypot(p.x - ego.x, p.z - ego.z);
        const patrols = [...s.patrols];
        const actualStep = p => Math.hypot(p.x - p.previous.x, p.z - p.previous.z);
        const nearbyMoving = patrols.filter(p => range(p) <= 65 && actualStep(p) > .033);
        const radioMoving = patrols.filter(p => p.aiState === "RADIO_SUPPORT" && actualStep(p) > .033);
        tracker.peakMobileLocal = Math.max(tracker.peakMobileLocal, nearbyMoving.length);
        tracker.maxPatrolStepM = Math.max(tracker.maxPatrolStepM, ...patrols.map(actualStep));
        tracker.relaySamples += Number(radioMoving.length > 0);
        tracker.contactSamples += Number(s.response.unitsInContact > 0);
        for (const unit of radioMoving) tracker.movedRadio.add(unit.id);
        let people = 0, traffic = 0;
        for (const actor of world.actorIndex.near(ego, 45)) {
          if (actor === ego || range(actor) > 45 || s.patrols.has(actor)) continue;
          if (actor.type === "pedestrian" && actualStep(actor) > .003) {
            tracker.peopleSeen.add(actor.id);
            people++;
          } else if (actor.type === "vehicle") {
            tracker.trafficSeen.add(actor.id);
            traffic++;
          }
        }
        tracker.overlapSamples += Number(nearbyMoving.length >= 3 && people >= 2 && traffic >= 2);
        const decision = s.frozenDriver?.lastDecision;
        tracker.safetyActions += Number(decision?.submitted?.brake > .15 ||
          /bypass|evade|yield/.test(decision?.planner?.maneuver ?? ""));
        tracker.nitroViolations += Number(ego.nitroActive && ego.nitroSuppressedByPedestrian);
        tracker.trace.push({ tick: world.tick - s.startedTick, x: ego.x, z: ego.z, speed: ego.speed,
          distanceM: s.metrics.distanceM, nearbyMoving: nearbyMoving.length, inSight: s.response.unitsInContact,
          radioMoving: radioMoving.map(p => p.id), people, traffic, approach: decision?.planner?.maneuver ?? null });
      }
    }, chunk);
    if (chunk === 3 && !negative) {
      await id("chaseCamBtn").click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await shot("chase-pack-and-crowd.png");
    }
  }
  report.run = await page.evaluate(() => {
    const { world } = window.sim, t = window.chaseWitness, s = world.pursuit;
    const people = new Set(t.actors.filter(a => a.type === "pedestrian").map(a => a.id));
    const civilian = new Set([...t.actors.filter(a => a !== world.player && a.type === "vehicle"),
      ...world.statics.filter(a => a.kind === "parked-vehicle")].map(a => a.id));
    const hits = s.events.filter(e => e.kind === "impact");
    return {
      phase: s.phase, seconds: (world.tick - s.startedTick) / 60,
      distanceM: s.metrics.distanceM, contacts: s.metrics.collisions,
      pedestrianContacts: hits.filter(e => people.has(e.actorId)).length,
      civilianVehicleContacts: hits.filter(e => civilian.has(e.actorId)).length,
      countedPeopleContacts: s.metrics.pedestrianCollisions,
      countedVehicleContacts: s.metrics.civilianVehicleContacts ?? null,
      ambientContacts: s.metrics.trafficCollisions,
      driver: s.frozenDriver.status, decisions: s.frozenDriver.decisions,
      health: world.player.health, peopleSeenNear: t.peopleSeen.size, trafficSeenNear: t.trafficSeen.size,
      relaySeconds: t.relaySamples / 10, visibleSeconds: t.contactSamples / 10,
      concurrentPressureSeconds: t.overlapSamples / 10, distinctRadio: t.movedRadio.size,
      peakMobileLocal: t.peakMobileLocal, maxPatrolStepM: t.maxPatrolStepM,
      stablePatrolIdentities: t.patrols.length === s.patrols.size && t.patrols.every(p => s.patrols.has(p)),
      safetyActions: t.safetyActions, nitroViolations: t.nitroViolations, trace: t.trace,
    };
  });
  assert.ok(report.run.relaySeconds >= 2, "No active radio convergence in the measured window");
  assert.equal(report.opening.profile, "metro-pack-pressure-v1");
  assert.ok(report.opening.nearbyPatrols >= 3 && report.opening.approachSectors >= 2);
  assert.equal(report.run.driver, "active");
  assert.ok(report.run.decisions >= 150 && report.run.safetyActions > 0);
  assert.ok(report.run.seconds >= 18 && report.run.distanceM >= 75);
  assert.ok(report.run.peopleSeenNear >= 12 && report.run.trafficSeenNear >= 6);
  assert.ok(report.run.peakMobileLocal >= 3 && report.run.concurrentPressureSeconds >= 1);
  assert.ok(report.run.distinctRadio >= 2 && report.run.stablePatrolIdentities && report.run.maxPatrolStepM < .7);
  assert.equal(report.run.pedestrianContacts, 0);
  assert.equal(report.run.civilianVehicleContacts, 0);
  assert.equal(report.run.pedestrianContacts, report.run.countedPeopleContacts);
  assert.equal(report.run.civilianVehicleContacts, report.run.countedVehicleContacts);
  assert.equal(report.run.nitroViolations, 0);
  assert.match(await id("pursuitScene").textContent(), /0 people · 0 civilian vehicles/);
  await shot("chase-18-seconds.png");

  await id("stopChaseBtn").click();
  report.sameCityOnStop = await page.evaluate(() => {
    const { world, view } = window.sim, t = window.chaseWitness;
    return world === t.world && view === t.view && world.player === t.player &&
      world.pursuit.phase === "stopped" && t.actors.every(a => world.actors.includes(a));
  });
  assert.equal(report.sameCityOnStop, true);
  await id("pursuitLevel").selectOption("4");
  await id("pakoDriverManual").click();
  await begin();
  report.manualRetry = await page.evaluate(() => {
    const { world } = window.sim, witness = window.chaseWitness;
    return world === witness.world && witness.actors.every(a => world.actors.includes(a)) &&
      world.pursuit.level === 4 && !world.pursuit.frozenDriver &&
      [...world.pursuit.patrols].every(unit => !witness.patrols.includes(unit));
  });
  assert.equal(report.manualRetry, true);
  await id("stopChaseBtn").click();
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(join(output, "chase-pressure.json"), `${JSON.stringify(report, null, 2)}\n`);
}
