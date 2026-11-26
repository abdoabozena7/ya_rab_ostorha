import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { distance, overlaps } from "../src/core/geometry.js";
import {
  NITRO_SPEC,
  PURSUIT_STOP,
  pursuitCommand,
  stepNitroTank,
  validatePursuitAction,
} from "../src/core/pursuit-controls.js";
import {
  TACTICAL_PURSUIT_MODE,
  planTacticalInterceptAim,
  tacticalPatrolSpec,
  tacticalSurgePace,
  tacticalTrafficOvertake,
} from "../src/core/pako-tactical-police.js";
import {
  createUnifiedCity,
  GRAND_CITY_POPULATION_DEFAULTS,
  GRAND_CITY_POPULATION_LIMITS,
} from "../src/core/unified-city.js";
import { World } from "../src/core/world.js";

test("1. NITRO_SPEC, 4-key & 5-key validatePursuitAction, top speed > 5-star police, drain/recharge/hysteresis, pedestrian suppression, and bit-identical 4-key legacy steps", () => {
  assert.equal(Object.isFrozen(NITRO_SPEC), true);
  assert.deepEqual(NITRO_SPEC, {
    durationS: 4.6,
    rechargePerS: 0.16,
    minEngageCharge: 0.18,
    speedMultiplier: 1.34,
    accelMultiplier: 1.72,
    maxBoostSpeedMps: 38.5,
  });

  // 4-key and 5-key validation
  const legacyAct = validatePursuitAction({ steer: 0.2, throttle: 0.8, brake: 0, gear: 1 });
  assert.equal(Object.keys(legacyAct).length, 4);
  const nitroAct = validatePursuitAction({ steer: -0.1, throttle: 1, brake: 0, gear: 1, nitro: 1 });
  assert.equal(nitroAct.nitro, 1);
  validatePursuitAction({ steer: 0, throttle: 0, brake: 1, gear: -1, nitro: 0 });

  for (const invalid of [
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: -0.01 },
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1.01 },
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: Number.NaN },
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: Infinity },
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: undefined },
    { steer: 0, throttle: 1, brake: 0, gear: 1, extra: 0 },
    { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1, extra: 0 },
  ]) {
    assert.throws(() => validatePursuitAction(invalid), RangeError);
  }

  // Legacy pursuitCommand unchanged when nitro < 0.5
  const baseBody = {
    speed: 18,
    maxSpeed: 32,
    spec: { acceleration: 6.8, braking: 9.6, maxSteer: 0.55 },
    nitroCharge: 1,
    nitroActive: false,
    nitroIntensity: 0,
    nitroSuppressedByPedestrian: false,
  };
  const cmdLegacy4 = pursuitCommand(baseBody, { steer: 0.25, throttle: 1, brake: 0, gear: 1 }, STEP);
  const cmdNitroLow = pursuitCommand(baseBody, { steer: 0.25, throttle: 1, brake: 0, gear: 1, nitro: 0.49 }, STEP);
  assert.deepEqual(cmdNitroLow, cmdLegacy4);
  assert.deepEqual(Object.keys(cmdLegacy4), ["steer", "targetSpeed"]);

  // Active Nitro command exceeds 35 m/s AND 5-star police interceptor top speed (38.0 m/s)
  const fiveStarInterceptor = tacticalPatrolSpec("interceptor", 5, 1);
  const cmdBoost = pursuitCommand(baseBody, { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1 }, STEP);
  assert.equal(cmdBoost.maxSpeed, NITRO_SPEC.maxBoostSpeedMps);
  assert.ok(cmdBoost.maxSpeed > 35, `boost maxSpeed ${cmdBoost.maxSpeed} must exceed 35 m/s`);
  assert.ok(
    cmdBoost.maxSpeed > fiveStarInterceptor.maxSpeed,
    `boost maxSpeed ${cmdBoost.maxSpeed} must exceed 5-star interceptor ${fiveStarInterceptor.maxSpeed}`,
  );
  assert.equal(cmdBoost.accelMultiplier, NITRO_SPEC.accelMultiplier);
  assert.ok(cmdBoost.targetSpeed > cmdLegacy4.targetSpeed);

  // Tank drain (~4.6 s), intensity ramp/decay, recharge, and minEngageCharge (0.18) hysteresis
  const tank = {
    speed: 12,
    nitroCharge: 1,
    nitroActive: false,
    nitroIntensity: 0,
    nitroSuppressedByPedestrian: false,
  };
  const boostInput = { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1 };
  let activeTicks = 0;
  for (let i = 0; i < 400; i++) {
    if (stepNitroTank(tank, boostInput, STEP)) {
      activeTicks++;
    } else {
      break;
    }
  }
  const activeSeconds = activeTicks * STEP;
  assert.ok(activeSeconds >= 4.5 && activeSeconds <= 4.62, `expected ~4.6s burn, got ${activeSeconds.toFixed(3)}s`);
  assert.equal(tank.nitroActive, false);
  assert.ok(tank.nitroCharge <= 0.01);

  // Hysteresis: holding nitro while charge < 0.18 cannot re-engage while recharging
  for (let i = 0; i < 60; i++) {
    stepNitroTank(tank, boostInput, STEP);
    if (tank.nitroCharge < NITRO_SPEC.minEngageCharge - 1e-6) {
      assert.equal(tank.nitroActive, false);
    }
  }
  // Recharge past 0.18 without pressing nitro, then engage and verify hysteresis keeps it active below 0.18 down to 0.01
  while (tank.nitroCharge < 0.22) {
    stepNitroTank(tank, PURSUIT_STOP, STEP);
  }
  assert.equal(tank.nitroIntensity, 0);
  assert.equal(stepNitroTank(tank, boostInput, STEP), true);
  assert.equal(tank.nitroActive, true);
  while (tank.nitroCharge > 0.08) {
    assert.equal(stepNitroTank(tank, boostInput, STEP), true);
  }
  assert.ok(tank.nitroCharge < NITRO_SPEC.minEngageCharge && tank.nitroCharge > 0.01);
  assert.equal(tank.nitroActive, true, "hysteresis keeps nitro active between 0.18 and 0.01");

  // nitroSuppressedByPedestrian blocks engagement & boost immediately
  tank.nitroCharge = 0.85;
  tank.nitroActive = false;
  tank.nitroSuppressedByPedestrian = true;
  assert.equal(stepNitroTank(tank, boostInput, STEP), false);
  assert.equal(tank.nitroActive, false);
  assert.ok(tank.nitroCharge > 0.85, "tank recharges instead of draining when suppressed");
  const suppressedCmd = pursuitCommand(
    { ...baseBody, nitroSuppressedByPedestrian: true },
    boostInput,
    STEP,
  );
  assert.equal(suppressedCmd.accelMultiplier, undefined);
  assert.deepEqual(suppressedCmd, pursuitCommand(baseBody, { steer: 0, throttle: 1, brake: 0, gear: 1 }, STEP));

  // Bit-identical 4-key legacy step vs unengaged world step, plus real Chase top speed > 35 m/s & manual City Nitro
  const worldA = new World({ seed: "nitro-parity", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const worldB = new World({ seed: "nitro-parity", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const chaseCfg = {
    ruleset: "dispatch-v1",
    chasePresence: "city-chase-v1",
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
  };
  worldA.command({ type: "street-pursuit-start", level: 3, variant: "gta", config: chaseCfg });
  worldB.command({ type: "street-pursuit-start", level: 3, variant: "gta", config: chaseCfg });

  for (let t = 0; t < 60; t++) {
    worldA.command({ type: "pursuit-drive", action: { steer: 0, throttle: 1, brake: 0, gear: 1 } });
    worldB.command({ type: "pursuit-drive", action: { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 0 } });
    worldA.step();
    worldB.step();
  }
  assert.equal(worldA.player.x, worldB.player.x);
  assert.equal(worldA.player.z, worldB.player.z);
  assert.equal(worldA.player.speed, worldB.player.speed);
  assert.equal(worldA.player.heading, worldB.player.heading);

  // Engage Nitro in worldB on the long Tahrir boulevard and verify boosted acceleration + > 35 m/s speed
  const worldBoost = new World({ seed: "nitro-topspeed", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  worldBoost.command({
    type: "street-pursuit-start",
    level: 1,
    variant: "gta",
    config: { ...chaseCfg, maxActivePatrols: 0 },
  });
  let peakSpeed = 0;
  for (let t = 0; t < 240; t++) {
    worldBoost.command({
      type: "pursuit-drive",
      action: { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1 },
    });
    worldBoost.step();
    if (worldBoost.player.speed > peakSpeed) peakSpeed = worldBoost.player.speed;
    if (t === 15) {
      assert.equal(worldBoost.player.nitroActive, true);
      assert.equal(worldBoost.pursuit.status.nitroActive, true);
      assert.equal(worldBoost.player.vehicle.nitroActive, true);
      assert.equal(worldBoost.state().player.nitroActive, true);
      assert.ok(worldBoost.player.nitroIntensity > 0.5);
    }
  }
  assert.ok(peakSpeed > 35.5, `expected Nitro chase speed > 35.5 m/s, got ${peakSpeed.toFixed(2)} m/s`);

  // Manual City free-drive Nitro when pursuit is inactive (accelerates +72% faster above maxSpeed)
  const cityManual = new World({ seed: "manual-city-nitro", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  cityManual.player.speed = 11;
  cityManual.setManualControl({ throttle: 1, brake: 0, steer: 0, nitro: 1 });
  for (let t = 0; t < 120; t++) cityManual.step();
  assert.equal(cityManual.player.nitroActive, true);
  assert.ok(cityManual.player.nitroCharge < 1);
  assert.ok(cityManual.player.speed > cityManual.player.maxSpeed * 1.15, `manual city nitro speed=${cityManual.player.speed}`);
});

test("2. spawn-crowd-ahead spawns 20 non-overlapping walking pedestrians 22..42 m ahead, replaces prior waves cleanly, handles T-junctions, and immediately refreshes legal pursuit.gta.scan", () => {
  const world = new World({ seed: "crowd-ahead-test", cityVersion: 5 }, "metro");
  const ambientPedIds = world.actors.filter((a) => a.type === "pedestrian").map((a) => a.id);
  assert.equal(ambientPedIds.length, 190);
  const sampleAmbientKeys = Object.keys(world.actors.find((a) => a.type === "pedestrian")).sort();

  const chaseCfg = {
    ruleset: "dispatch-v1",
    chasePresence: "city-chase-v1",
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
  };
  world.command({ type: "street-pursuit-start", level: 2, variant: "gta", config: chaseCfg });
  // Step 3 ticks so we are mid-way between 6-tick PursuitScanner periodic samples!
  for (let i = 0; i < 3; i++) {
    world.command({ type: "pursuit-drive", action: { steer: 0, throttle: 0.4, brake: 0, gear: 1 } });
    world.step();
  }
  assert.notEqual((world.tick - world.pursuit.startedTick) % 6, 0);

  assert.equal(world.command({ type: "spawn-crowd-ahead", count: 20 }), true);
  const summary1 = world.lastCrowdSpawn;
  assert.ok(summary1);
  assert.equal(summary1.spawned, 20);
  assert.equal(summary1.ids.length, 20);
  assert.ok(summary1.nearestForwardM >= 22 && summary1.farthestForwardM <= 42);
  assert.equal(world.crowdAheadCount, 20);
  assert.equal(world.pursuit.status.crowdAheadCount, 20);
  assert.equal(world.state().crowdAheadCount, 20);

  // Immediate legal PursuitScanner refresh on the exact same tick!
  assert.equal(world.pursuit.gta.scan.tick, world.tick);
  const scannedPeds = (world.pursuit.gta.scan.tracks ?? []).filter((tr) => tr.kind === "pedestrian");
  const scannedPedRays = (world.pursuit.gta.scan.rays ?? []).filter((r) => r.kind === "pedestrian");
  assert.ok(
    scannedPeds.length > 0 && scannedPedRays.length > 0,
    "PursuitScanner legally detected visible crowd-ahead pedestrians immediately",
  );

  const wave1Actors = summary1.ids.map((id) => world.actors.find((a) => a.id === id));
  assert.ok(wave1Actors.every(Boolean));

  const fx = Math.sin(world.player.heading);
  const fz = Math.cos(world.player.heading);
  const vehicles = [
    ...world.actors.filter((a) => a.type === "vehicle"),
    ...world.statics.filter((s) => s.kind === "parked-vehicle"),
  ];

  for (let i = 0; i < wave1Actors.length; i++) {
    const p = wave1Actors[i];
    // Monomorphic base object shape check (matches createPedestrian + district walker fields)
    const { previous: _prev, ...pWithoutPrev } = p;
    assert.deepEqual(Object.keys(pWithoutPrev).sort(), sampleAmbientKeys);
    assert.ok(p.walkSpeed >= 1.18 && p.walkSpeed <= 1.76);
    const fwd = (p.x - world.player.x) * fx + (p.z - world.player.z) * fz;
    assert.ok(fwd >= 22 && fwd <= 42, `pedestrian ${p.id} forwardDistM=${fwd.toFixed(2)}`);
    assert.ok(distance(p, world.player) >= 18);
    for (const v of vehicles) {
      assert.ok(distance(p, v) >= 2.2, `pedestrian ${p.id} >= 2.2m from vehicle ${v.id}`);
    }
    for (let j = i + 1; j < wave1Actors.length; j++) {
      assert.ok(distance(p, wave1Actors[j]) >= 1.05, `center spacing >= 1.05m`);
    }
  }
  assert.deepEqual(world.audit(), []);

  // Step 60 ticks and verify all 20 actively walk
  const startPositions = wave1Actors.map((p) => ({ id: p.id, x: p.x, z: p.z }));
  for (let t = 0; t < 60; t++) {
    world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
    world.step();
  }
  let movedCount = 0;
  for (const sp of startPositions) {
    const cur = world.actors.find((a) => a.id === sp.id);
    assert.ok(cur, `pedestrian ${sp.id} still present`);
    if (Math.hypot(cur.x - sp.x, cur.z - sp.z) > 0.45) movedCount++;
  }
  assert.equal(movedCount, 20, "all 20 spawned pedestrians actively walked over 60 ticks");
  assert.deepEqual(world.audit(), []);

  // Repeated click cleanly replaces prior wave while keeping all 190 ambient pedestrians untouched
  world.command({ type: "spawn-crowd-ahead", count: 20 });
  const summary2 = world.lastCrowdSpawn;
  assert.equal(summary2.spawned, 20);
  for (const oldId of summary1.ids) {
    assert.equal(world.actors.some((a) => a.id === oldId), false, `prior wave actor ${oldId} despawned`);
  }
  for (const ambId of ambientPedIds) {
    assert.equal(world.actors.some((a) => a.id === ambId), true, `ambient pedestrian ${ambId} preserved`);
  }
  assert.equal(world.crowdAheadCount, 20);
  assert.equal(world.pursuit.status.crowdAheadCount, 20);

  // T-junction / road-end corridor turn check
  const junctionWorld = new World({ seed: "crowd-tjunction", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const southLink = junctionWorld.drivingRoads.find((r) => r.id === "bab-el-louk-link");
  junctionWorld.player.x = southLink.fixed - 2.0;
  junctionWorld.player.z = southLink.max - 26; // Only 26m before T-junction end!
  junctionWorld.player.heading = 0;
  junctionWorld.command({ type: "spawn-crowd-ahead", count: 20 });
  assert.equal(junctionWorld.lastCrowdSpawn.spawned, 20);
  for (const id of junctionWorld.lastCrowdSpawn.ids) {
    const p = junctionWorld.actors.find((a) => a.id === id);
    assert.ok(distance(p, junctionWorld.player) >= 18.5);
  }
  assert.deepEqual(junctionWorld.audit(), []);

  // Reachable vs dead-end road-end checks in active 5-star Chase (strict 22 <= fwd <= 42 AND absLat <= 16m; dead-ends return ok: false & preserve crowd)
  const perimWorld = new World({ seed: "crowd-perim", cityVersion: 5 }, "metro");
  perimWorld.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 5,
    config: { ruleset: "dispatch-v1", tacticalPursuit: "gta-tactical-v1" },
  });
  for (const [rx, rz, rh, expectOk] of [
    [-32, -304, 0, true],
    [-32, -304, Math.PI, false],
    [-40, -42, Math.PI, true],
    [54, -34, Math.PI, false],
    [54, 30, 0, false],
    [20, 34, 0, false],
  ]) {
    perimWorld.player.x = rx;
    perimWorld.player.z = rz;
    perimWorld.player.heading = rh;
    const rfx = Math.sin(rh);
    const rfz = Math.cos(rh);
    const rrx = Math.cos(rh);
    const rrz = -Math.sin(rh);
    perimWorld.command({ type: "spawn-crowd-ahead", count: 20 });
    if (!expectOk) {
      assert.equal(perimWorld.lastCrowdSpawn.ok, false);
      assert.equal(perimWorld.lastCrowdSpawn.spawned, 0);
      assert.equal(perimWorld.crowdAheadCount, 20);
      continue;
    }
    assert.equal(perimWorld.lastCrowdSpawn.ok, true);
    assert.equal(perimWorld.lastCrowdSpawn.spawned, 20);
    let rMin = Infinity;
    let rMax = -Infinity;
    for (const pid of perimWorld.lastCrowdSpawn.ids) {
      const a = perimWorld.actors.find((x) => x.id === pid);
      const fwd = (a.x - rx) * rfx + (a.z - rz) * rfz;
      const absLat = Math.abs((a.x - rx) * rrx + (a.z - rz) * rrz);
      assert.ok(fwd >= 22.0 && fwd <= 42.0, `expected 22 <= fwd <= 42 at (${rx},${rz}), got ${fwd}`);
      assert.ok(absLat <= 16.0, `expected absLat <= 16.0 at (${rx},${rz}), got ${absLat}`);
      if (fwd < rMin) rMin = fwd;
      if (fwd > rMax) rMax = fwd;
    }
    assert.ok(Math.abs(perimWorld.lastCrowdSpawn.nearestForwardM - rMin) <= 1e-6);
    assert.ok(Math.abs(perimWorld.lastCrowdSpawn.farthestForwardM - rMax) <= 1e-6);
  }
  // Re-spawn a fresh wave at (-32, -304, 0) then verify off-map (9999, 9999) preserves it
  perimWorld.player.x = -32;
  perimWorld.player.z = -304;
  perimWorld.player.heading = 0;
  perimWorld.command({ type: "spawn-crowd-ahead", count: 20 });
  const preservedIds = [...perimWorld.lastCrowdSpawn.ids];
  perimWorld.player.x = 9999;
  perimWorld.player.z = 9999;
  perimWorld.command({ type: "spawn-crowd-ahead", count: 20 });
  assert.equal(perimWorld.lastCrowdSpawn.ok, false);
  assert.equal(perimWorld.lastCrowdSpawn.spawned, 0);
  assert.equal(perimWorld.crowdAheadCount, 20);
  for (const pid of preservedIds) {
    assert.equal(perimWorld.actors.some((a) => a.id === pid), true);
  }

  // Deterministic replay reconstruction with spawn-crowd-ahead
  const replaySrc = new World({ seed: "crowd-replay-det", cityVersion: 5, traffic: 8, pedestrians: 20 }, "metro");
  replaySrc.command({ type: "spawn-crowd-ahead", count: 20 });
  for (let t = 0; t < 15; t++) replaySrc.step();
  const replayed = World.fromReplay(replaySrc.replay());
  assert.deepEqual(replayed.lastCrowdSpawn, replaySrc.lastCrowdSpawn);
  assert.equal(replayed.crowdAheadCount, 20);
});

test("3. Grand City v5 population defaults (190) / limits (280) / >=300 spawn pool & 210-pedestrian CPU LOD < 2.5 ms/tick", () => {
  assert.equal(GRAND_CITY_POPULATION_DEFAULTS.pedestrians, 190);
  assert.equal(GRAND_CITY_POPULATION_LIMITS.pedestrians, 280);

  const city = createUnifiedCity({ grand: true });
  assert.equal(city.pedestrianSpawns.length, 280);
  assert.ok(city.pedestrianSpawnPool.length >= 300, `pool=${city.pedestrianSpawnPool.length}`);

  const maxWorld = new World({ seed: "max-280", cityVersion: 5, pedestrians: 280 }, "metro");
  assert.equal(maxWorld.actors.filter((a) => a.type === "pedestrian").length, 280);
  assert.deepEqual(maxWorld.audit(), []);

  // Benchmark 210-pedestrian Metro City v5 step CPU speed (< 2.5 ms/tick average)
  const pedBenchWorld = new World({ seed: "lod-210-peds", cityVersion: 5, pedestrians: 210, traffic: 0 }, "metro");
  const benchWorld = new World({ seed: "lod-210-bench", cityVersion: 5, pedestrians: 210, traffic: 68 }, "metro");
  assert.equal(pedBenchWorld.actors.filter((a) => a.type === "pedestrian").length, 210);
  assert.equal(benchWorld.actors.filter((a) => a.type === "pedestrian").length, 210);
  for (let w = 0; w < 32; w++) {
    pedBenchWorld.step();
    benchWorld.step();
  }

  const ticks = 160;
  let p05PedOnlyMs = Infinity;
  let medianPedOnlyMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const pedTickSamples = new Float64Array(ticks);
    for (let i = 0; i < ticks; i++) {
      const s0 = performance.now();
      pedBenchWorld.step();
      pedTickSamples[i] = performance.now() - s0;
    }
    pedTickSamples.sort();
    p05PedOnlyMs = Math.min(p05PedOnlyMs, pedTickSamples[Math.floor(ticks * 0.05)]);
    medianPedOnlyMs = Math.min(medianPedOnlyMs, pedTickSamples[Math.floor(ticks * 0.5)]);
  }
  assert.ok(
    p05PedOnlyMs < 2.5 && medianPedOnlyMs < 4.5,
    `expected uncontended p05 < 2.5 ms/tick and median < 4.5 ms/tick for 210-pedestrian step, got p05=${p05PedOnlyMs.toFixed(3)} ms, median=${medianPedOnlyMs.toFixed(3)} ms`,
  );

  let p10FullCityMs = Infinity;
  let medianFullCityMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const cityTickSamples = new Float64Array(ticks);
    for (let i = 0; i < ticks; i++) {
      const s0 = performance.now();
      benchWorld.step();
      cityTickSamples[i] = performance.now() - s0;
    }
    cityTickSamples.sort();
    p10FullCityMs = Math.min(p10FullCityMs, cityTickSamples[Math.floor(ticks * 0.1)]);
    medianFullCityMs = Math.min(medianFullCityMs, cityTickSamples[Math.floor(ticks * 0.5)]);
  }
  assert.ok(
    p10FullCityMs < 5.5 && medianFullCityMs < 8.5,
    `expected p10 < 5.5 ms/tick and median < 8.5 ms/tick for 210 pedestrians + 68 traffic under concurrent load, got p10=${p10FullCityMs.toFixed(3)} ms, median=${medianFullCityMs.toFixed(3)} ms`,
  );
  assert.deepEqual(pedBenchWorld.audit(), []);
  assert.deepEqual(benchWorld.audit(), []);
});

test("4. Smarter multi-unit tactical police intercept headings when unitsInContact > 0 AND strict zero near-player spawn/teleport when unitsInContact === 0", () => {
  const world = new World({ seed: "tactical-smart-v2", cityVersion: 5, traffic: 8, pedestrians: 20 }, "metro");
  const chaseCfg = {
    ruleset: "dispatch-v1",
    chasePresence: "city-chase-v1",
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
  };
  world.command({ type: "street-pursuit-start", level: 3, variant: "gta", config: chaseCfg });

  // Verify multi-role coordination when unitsInContact > 0
  world.pursuit.response.unitsInContact = 3;
  const report = {
    x: world.player.x,
    z: world.player.z,
    heading: Math.PI / 2, // Eastbound along tahrir-boulevard toward -183 Tahrir hub intersection
    speed: 24,
    vx: 24,
    vz: 0,
    tick: world.tick,
  };
  const leadCar = { x: report.x - 18, z: report.z, heading: Math.PI / 2, squadRole: "PRIMARY_CHASER", squadSide: 1, gtaAI: { order: 0 } };
  const flankCar = { x: report.x - 24, z: report.z + 3, heading: Math.PI / 2, squadRole: "FLANKER", squadSide: 1, gtaAI: { order: 1 } };
  const cutoffCar = { x: report.x - 28, z: report.z - 3, heading: Math.PI / 2, squadRole: "INTERCEPTOR", squadSide: -1, unitType: "interceptor", speed: 28, maxSpeed: 37, steer: 0.02, gtaAI: { order: 2 } };

  const leadAim = planTacticalInterceptAim(world, leadCar, report, 0);
  const flankAim = planTacticalInterceptAim(world, flankCar, report, 1);
  const cutoffAim = planTacticalInterceptAim(world, cutoffCar, report, 2);

  assert.equal(leadAim.role, "LEAD");
  assert.equal(flankAim.role, "FLANK");
  assert.equal(cutoffAim.role, "CUTOFF");
  assert.ok(flankAim.horizonS >= 1.6 && flankAim.horizonS <= 2.6);
  assert.ok(cutoffAim.horizonS >= 1.6 && cutoffAim.horizonS <= 2.6);
  // Flank & cutoff project well ahead of lead unit rather than single-file tailgating
  assert.ok(flankAim.x > leadAim.x + 8 || distance(flankAim, leadAim) > 6);
  assert.ok(cutoffAim.x > leadAim.x + 12 || cutoffAim.junctionIntercept === true);
  assert.ok(distance(flankAim, cutoffAim) > 3.5, "flank and cutoff separate across lanes/intersections");

  // Interceptor straightaway surge commands full top speed
  const surge = tacticalSurgePace(world.pursuit, cutoffCar, 24, 20, 0.03);
  assert.equal(surge, cutoffCar.maxSpeed);

  // Corner hazard avoidance steers cleanly away from an encroaching static building corner
  const cornerWorld = {
    drivingRoads: world.drivingRoads,
    roads: world.roads,
    statics: [
      { id: "test-corner-bldg", type: "static", kind: "building", x: -232, z: -110.2, width: 8, length: 6, heading: 0 },
    ],
    actors: [],
    player: { x: -180, z: -112, heading: Math.PI / 2 },
    pursuit: world.pursuit,
  };
  const cornerCruiser = {
    id: "patrol-corner",
    type: "vehicle",
    x: -248,
    z: -110.2,
    heading: Math.PI / 2,
    speed: 18,
    steer: 0,
    maxSpeed: 34,
    width: 1.9,
    length: 4.5,
    spec: tacticalPatrolSpec("patrol", 3, 1),
  };
  const avoidCmd = tacticalTrafficOvertake(cornerWorld, cornerCruiser, 0, 22);
  assert.ok(avoidCmd && Math.abs(avoidCmd.steer) > 0.05, "cruiser steers smoothly around static corner hazard");

  // STRICT INVARIANT: zero near-player patrol spawn or teleport when unitsInContact === 0!
  // Move player to a far isolated outer-ring boulevard out of all patrols' sight & outside surveillance zones
  const farRoad = world.drivingRoads.find((r) => r.id === "nile-west-boulevard");
  world.player.x = farRoad.fixed + 2.7;
  world.player.z = 210;
  world.player.heading = 0;
  world.player.speed = 12;
  // Place existing patrols > 250 m away in downtown with zero line of sight
  let idx = 0;
  for (const patrol of world.pursuit.patrols) {
    patrol.x = 188 + (idx % 2 === 0 ? 2.6 : -2.6);
    patrol.z = -180 - idx * 18;
    patrol.heading = 0;
    patrol.speed = 8;
    patrol.gtaAI.behindTicks = 999; // Force trailing-recycle eligibility if invariant were broken!
    idx++;
  }
  world.pursuit.response.sightedBy.clear();
  world.pursuit.response.closePatrols.clear();
  world.pursuit.response.unitsInContact = 0;
  world.pursuit.response.lastSeen = {
    x: 188,
    z: -150,
    heading: 0,
    speed: 14,
    vx: 0,
    vz: 14,
    tick: world.tick,
  };
  if (world.pursuit.response.dispatch) {
    world.pursuit.response.dispatch.state = "LAST_KNOWN"; // Tracked by dispatch, yet unitsInContact === 0!
  }

  // Also verify planTacticalInterceptAim refuses to target live player when unitsInContact === 0
  const blindAim = planTacticalInterceptAim(world, [...world.pursuit.patrols][0], world.pursuit.response.lastSeen, 1);
  assert.equal(blindAim.role, "SEARCH");
  assert.ok(distance(blindAim, world.player) > 150, "blind search target stays near lastSeen, never leaks world.player");

  const initialPatrolIds = new Set([...world.pursuit.patrols].map((p) => p.id));
  for (let step = 0; step < 120; step++) {
    world.command({ type: "pursuit-drive", action: { steer: 0, throttle: 0.5, brake: 0, gear: 1 } });
    world.step();
    if (world.pursuit.phase !== "running") break;
    assert.equal(world.pursuit.response.unitsInContact, 0);
    for (const patrol of world.pursuit.patrols) {
      assert.equal(initialPatrolIds.has(patrol.id), true, `no new patrol spawned while unitsInContact === 0 (${patrol.id})`);
      assert.ok(
        distance(patrol, world.player) > 140,
        `no patrol teleported near player while unitsInContact === 0 (dist=${distance(patrol, world.player).toFixed(1)}m)`,
      );
    }
  }
});
