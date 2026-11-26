import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { STEP } from "../src/core/config.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import {
  SURFACE_SPECS,
  createCityTerrain,
  terrainElevationAt,
  terrainGradientAt,
  sampleCitySurface,
} from "../src/core/city-surfaces.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";

const REALISM_SPEC = Object.freeze({
  wheelbase: PLAYER_VEHICLE.wheelbaseM,
  maxSteer: PLAYER_VEHICLE.maxSteerRad,
  realisticDynamics: true,
  tireGripMps2: 8,
  contactResponse: "inelastic-slide-v1",
  massKg: PLAYER_VEHICLE.massKg,
});

function makeCar(overrides = {}) {
  return {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    y: 0,
    heading: 0,
    speed: 0,
    steer: 0,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    maxSpeed: 22,
    spec: REALISM_SPEC,
    vehicle: createVehicleState(),
    ...overrides,
  };
}

function assertAllFinite(value) {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `Expected finite number, got ${value}`);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) assertAllFinite(v);
  }
}

test("createCityTerrain builds deterministic smooth Grand Cairo hills, surface zones, and O(1) spatial queries", () => {
  assert.equal(Object.isFrozen(SURFACE_SPECS), true);
  for (const key of ["asphalt", "cobble", "sand", "water"]) {
    assert.equal(Object.isFrozen(SURFACE_SPECS[key]), true);
    assert.equal(SURFACE_SPECS[key].kind, key);
  }

  const terrainA = createCityTerrain();
  const terrainB = createCityTerrain();

  assert.ok(terrainA.hills.length >= 6, `expected >= 6 hills, got ${terrainA.hills.length}`);
  assert.ok(terrainA.maxElevation >= 3.0, `expected maxElevation >= 3.0m, got ${terrainA.maxElevation}`);
  assert.ok(terrainA.waterPuddles.length >= 18, `expected >= 18 waterPuddles, got ${terrainA.waterPuddles.length}`);
  assert.ok(terrainA.sandZones.length >= 14, `expected >= 14 sandZones, got ${terrainA.sandZones.length}`);
  assert.ok(terrainA.cobbleZones.length >= 8, `expected >= 8 cobbleZones, got ${terrainA.cobbleZones.length}`);

  // Determinism & key landmark features
  assert.equal(
    terrainElevationAt(terrainA, 24, -112),
    terrainElevationAt(terrainB, 24, -112),
  );
  assert.ok(terrainElevationAt(terrainA, 24, -112) >= 3.0, "Tahrir overpass ramp crest rises >= 3.0 m");
  assert.equal(terrainElevationAt(terrainA, -254, -109.3), 0, "Player spawn starts flat at 0 m");
  assert.equal(terrainElevationAt(terrainA, null, 0), 0);
  assert.equal(terrainElevationAt(null, 24, -112), 0);

  const westPuddle = sampleCitySurface(terrainA, -156, -109.2, Math.PI / 2);
  assert.equal(westPuddle.surfaceKind, "water");
  assert.equal(westPuddle.zoneId, "tahrir-west-puddle");
  assert.equal(westPuddle.gripMultiplier, SURFACE_SPECS.water.gripMultiplier);
  assert.ok(westPuddle.waterDepthM > 0.02);

  const tahrirSand = sampleCitySurface(terrainA, -108, -110.2, Math.PI / 2);
  assert.equal(tahrirSand.surfaceKind, "sand");
  assert.equal(tahrirSand.zoneId, "tahrir-sand-drift");
  assert.equal(tahrirSand.gripMultiplier, SURFACE_SPECS.sand.gripMultiplier);
  assert.ok(tahrirSand.sandDepthM > 0.02);

  const khanCobble = sampleCitySurface(terrainA, 124, 58, 0);
  assert.equal(khanCobble.surfaceKind, "cobble");
  assert.equal(khanCobble.gripMultiplier, SURFACE_SPECS.cobble.gripMultiplier);

  // Priority order when overlapping: water > sand > cobble > asphalt
  const overlapTerrain = createCityTerrain([], {
    hills: [],
    cobbleZones: [{ id: "c1", kind: "cobble", shape: "ellipse", x: 0, z: 0, heading: 0, halfWidth: 10, halfLength: 10, depthM: 0.015 }],
    sandZones: [{ id: "s1", kind: "sand", shape: "ellipse", x: 0, z: 0, heading: 0, halfWidth: 8, halfLength: 8, depthM: 0.04 }],
    waterPuddles: [{ id: "w1", kind: "water", shape: "ellipse", x: 0, z: 0, heading: 0, halfWidth: 5, halfLength: 5, depthM: 0.035 }],
  });
  assert.equal(sampleCitySurface(overlapTerrain, 0, 0).surfaceKind, "water");
  assert.equal(sampleCitySurface(overlapTerrain, 6, 0).surfaceKind, "sand");
  assert.equal(sampleCitySurface(overlapTerrain, 8.5, 0).surfaceKind, "cobble");
  assert.equal(sampleCitySurface(overlapTerrain, 15, 0).surfaceKind, "asphalt");

  // C¹-smooth continuous elevation and analytical gradient accuracy across the city
  const eps = 1e-4;
  for (let x = -480; x <= 400; x += 22) {
    for (let z = -390; z <= 340; z += 29) {
      const h0 = terrainElevationAt(terrainA, x, z);
      const hx = terrainElevationAt(terrainA, x + 0.01, z);
      const hz = terrainElevationAt(terrainA, x, z + 0.01);
      assert.ok(Math.abs(hx - h0) < 0.005, `elevation jump dx at (${x},${z}): ${Math.abs(hx - h0)}`);
      assert.ok(Math.abs(hz - h0) < 0.005, `elevation jump dz at (${x},${z}): ${Math.abs(hz - h0)}`);

      const grad = terrainGradientAt(terrainA, x, z);
      const numDx = (terrainElevationAt(terrainA, x + eps, z) - terrainElevationAt(terrainA, x - eps, z)) / (2 * eps);
      const numDz = (terrainElevationAt(terrainA, x, z + eps) - terrainElevationAt(terrainA, x, z - eps)) / (2 * eps);
      assert.ok(Math.abs(grad.dhdx - numDx) < 1e-5, `dhdx mismatch at (${x},${z})`);
      assert.ok(Math.abs(grad.dhdz - numDz) < 1e-5, `dhdz mismatch at (${x},${z})`);
    }
  }

  // O(1) spatial hash performance: 10,000 queries in < 25 ms
  const out = {};
  // Warm up JIT briefly
  for (let i = 0; i < 200; i++) {
    sampleCitySurface(terrainA, -200 + (i % 40) * 12, -150 + (i % 25) * 14, 0.4, out);
  }
  const t0 = performance.now();
  let checksum = 0;
  for (let i = 0; i < 10000; i++) {
    const qx = -500 + ((i * 37) % 920);
    const qz = -410 + ((i * 53) % 760);
    const s = sampleCitySurface(terrainA, qx, qz, (i & 7) * 0.4, out);
    checksum += s.gripMultiplier + s.elevationM;
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(Number.isFinite(checksum) && checksum > 0);
  assert.ok(elapsedMs < 25, `expected 10,000 sampleCitySurface calls < 25 ms, took ${elapsedMs.toFixed(2)} ms`);
});

test("sand vs asphalt physics: sand reduces 120-step acceleration by >= 1.8 m/s and widens high-speed turn slip", () => {
  let asphaltCar = makeCar({ speed: 0 });
  let sandCar = makeCar({ speed: 0 });

  for (let i = 0; i < 120; i++) {
    asphaltCar = integrateVehicle(
      asphaltCar,
      { targetSpeed: 16, steer: 0, surface: SURFACE_SPECS.asphalt },
      STEP,
    );
    sandCar = integrateVehicle(
      sandCar,
      { targetSpeed: 16, steer: 0, surface: SURFACE_SPECS.sand },
      STEP,
    );
  }

  assert.ok(sandCar.speed > 1.2, `car should still make forward progress on sand (${sandCar.speed})`);
  assert.ok(
    asphaltCar.speed - sandCar.speed >= 1.8,
    `expected sand to be >= 1.8 m/s slower than asphalt (${asphaltCar.speed} vs ${sandCar.speed})`,
  );

  // High-speed turn comparison: wider path + larger |chaseSlipRad| on sand than asphalt
  let turnAsphalt = makeCar({ speed: 14, steer: 0.36 });
  let turnSand = makeCar({ speed: 14, steer: 0.36 });
  for (let i = 0; i < 45; i++) {
    turnAsphalt = integrateVehicle(
      turnAsphalt,
      { targetSpeed: 14, steer: 0.36, surface: SURFACE_SPECS.asphalt },
      STEP,
    );
    turnSand = integrateVehicle(
      turnSand,
      { targetSpeed: 14, steer: 0.36, surface: SURFACE_SPECS.sand },
      STEP,
    );
  }
  assert.ok(
    Math.abs(turnSand.chaseSlipRad) > Math.abs(turnAsphalt.chaseSlipRad),
    `expected larger slip on sand (${turnSand.chaseSlipRad}) than asphalt (${turnAsphalt.chaseSlipRad})`,
  );
  assert.ok(
    turnSand.heading < turnAsphalt.heading,
    `expected sand grip limit to reduce yaw rotation / widen turn (${turnSand.heading} < ${turnAsphalt.heading})`,
  );
});

test("water vs asphalt physics: braking from 18 m/s takes >= 25% longer distance and cornering builds larger hydroplane slip", () => {
  let dryBrake = makeCar({ speed: 18 });
  let wetBrake = makeCar({ speed: 18 });
  let drySteps = 0;
  let wetSteps = 0;

  while (dryBrake.speed > 0 && drySteps < 600) {
    dryBrake = integrateVehicle(
      dryBrake,
      { targetSpeed: 0, steer: 0, surface: SURFACE_SPECS.asphalt },
      STEP,
    );
    drySteps++;
  }
  while (wetBrake.speed > 0 && wetSteps < 600) {
    wetBrake = integrateVehicle(
      wetBrake,
      { targetSpeed: 0, steer: 0, surface: SURFACE_SPECS.water },
      STEP,
    );
    wetSteps++;
  }

  assert.equal(dryBrake.speed, 0);
  assert.equal(wetBrake.speed, 0);
  assert.ok(
    wetBrake.z >= dryBrake.z * 1.25,
    `expected wet stopping distance (${wetBrake.z.toFixed(2)} m) >= 1.25x dry (${dryBrake.z.toFixed(2)} m)`,
  );

  // High-speed cornering on water produces unmistakable hydroplane drift slip > asphalt
  let dryTurn = makeCar({ speed: 15, steer: 0.35 });
  let wetTurn = makeCar({ speed: 15, steer: 0.35 });
  for (let i = 0; i < 30; i++) {
    dryTurn = integrateVehicle(
      dryTurn,
      { targetSpeed: 15, steer: 0.35, surface: SURFACE_SPECS.asphalt },
      STEP,
    );
    wetTurn = integrateVehicle(
      wetTurn,
      { targetSpeed: 15, steer: 0.35, surface: SURFACE_SPECS.water },
      STEP,
    );
  }
  assert.ok(
    Math.abs(wetTurn.chaseSlipRad) > Math.abs(dryTurn.chaseSlipRad) * 1.25,
    `expected hydroplane |chaseSlipRad| (${Math.abs(wetTurn.chaseSlipRad)}) > 1.25x dry (${Math.abs(dryTurn.chaseSlipRad)})`,
  );
});

test("uphill vs flat vs downhill slope physics: gravity affects acceleration and braking while service brake holds steady", () => {
  const uphillSurface = { ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0.08 };
  const flatSurface = { ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0 };
  const downhillSurface = { ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: -0.08 };

  let upCar = makeCar({ speed: 0 });
  let flatCar = makeCar({ speed: 0 });
  let downCar = makeCar({ speed: 0 });

  for (let i = 0; i < 120; i++) {
    upCar = integrateVehicle(upCar, { targetSpeed: 18, steer: 0, surface: uphillSurface }, STEP);
    flatCar = integrateVehicle(flatCar, { targetSpeed: 18, steer: 0, surface: flatSurface }, STEP);
    downCar = integrateVehicle(downCar, { targetSpeed: 18, steer: 0, surface: downhillSurface }, STEP);
  }

  assert.ok(upCar.speed > 0, "car climbs +8% grade cleanly");
  assert.ok(upCar.speed < flatCar.speed - 1.2, `uphill (${upCar.speed}) slower than flat (${flatCar.speed})`);
  assert.ok(downCar.speed > flatCar.speed + 1.2, `downhill (${downCar.speed}) faster than flat (${flatCar.speed})`);

  // Braking comparison from 15 m/s: uphill stops shortest, downhill takes longest
  let brakeUp = makeCar({ speed: 15 });
  let brakeFlat = makeCar({ speed: 15 });
  let brakeDown = makeCar({ speed: 15 });
  for (let i = 0; i < 300; i++) {
    if (brakeUp.speed > 0) {
      brakeUp = integrateVehicle(brakeUp, { targetSpeed: 0, steer: 0, surface: uphillSurface }, STEP);
    }
    if (brakeFlat.speed > 0) {
      brakeFlat = integrateVehicle(brakeFlat, { targetSpeed: 0, steer: 0, surface: flatSurface }, STEP);
    }
    if (brakeDown.speed > 0) {
      brakeDown = integrateVehicle(brakeDown, { targetSpeed: 0, steer: 0, surface: downhillSurface }, STEP);
    }
  }
  assert.equal(brakeUp.speed, 0);
  assert.equal(brakeFlat.speed, 0);
  assert.equal(brakeDown.speed, 0);
  assert.ok(brakeUp.z < brakeFlat.z, `uphill braking (${brakeUp.z}) shorter than flat (${brakeFlat.z})`);
  assert.ok(brakeDown.z > brakeFlat.z + 1.5, `downhill braking (${brakeDown.z}) longer than flat (${brakeFlat.z})`);

  // Service-braked stopped car holds rock-steady without creeping on both +8% and -8% grades
  let parkedUp = makeCar({ x: 10, z: 20, speed: 0 });
  let parkedDown = makeCar({ x: 10, z: 20, speed: 0 });
  for (let i = 0; i < 180; i++) {
    parkedUp = integrateVehicle(parkedUp, { targetSpeed: 0, steer: 0, surface: uphillSurface }, STEP);
    parkedDown = integrateVehicle(parkedDown, { targetSpeed: 0, steer: 0, surface: downhillSurface }, STEP);
  }
  assert.equal(parkedUp.speed, 0);
  assert.equal(parkedUp.x, 10);
  assert.equal(parkedUp.z, 20);
  assert.equal(parkedDown.speed, 0);
  assert.equal(parkedDown.x, 10);
  assert.equal(parkedDown.z, 20);

  // Neutral coasting on a steep +12% uphill rolls back downhill naturally
  const steepUp = { ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0.12 };
  let coastingOnHill = makeCar({ speed: 0 });
  for (let i = 0; i < 60; i++) {
    coastingOnHill = integrateVehicle(
      coastingOnHill,
      { targetSpeed: 0, coasting: true, steer: 0, surface: steepUp },
      STEP,
    );
  }
  assert.ok(coastingOnHill.speed < -0.5, `coasting on +12% hill rolls back (${coastingOnHill.speed})`);
});

test("suspension roughness, slope load redistribution, and 100% backwards compatibility without surface", () => {
  // 1. Exact byte-for-byte identity when surface is omitted
  for (const speed of [-1.5, 0, 4, 16]) {
    for (const targetSpeed of [-2, 0, 8, 20]) {
      for (const steer of [-0.4, 0, 0.45]) {
        const base = makeCar({ speed, steer: steer * 0.5, chaseSlipRad: -0.02 });
        const nextNoSurface = integrateVehicle(base, { targetSpeed, steer }, STEP);
        const nextUndefinedSurface = integrateVehicle(base, { targetSpeed, steer, surface: undefined }, STEP);
        assert.deepEqual(nextNoSurface, nextUndefinedSurface);

        const stateNoSurface = advanceVehicleState(base, nextNoSurface, { targetSpeed, steer }, STEP, { tick: 12 });
        const stateNullSurface = advanceVehicleState(
          base,
          nextNoSurface,
          { targetSpeed, steer },
          STEP,
          { tick: 12, surface: null },
        );
        assert.deepEqual(stateNoSurface, stateNullSurface);
        assert.equal("surface" in stateNoSurface, false);
      }
    }
  }
  assert.equal("surface" in createVehicleState(), false);

  // 2. Cobble & sand excite measurably stronger bounded finite suspension travel than smooth asphalt
  const runSurfaceRig = (spec) => {
    let car = makeCar({ speed: 8 });
    let peakHeave = 0;
    let peakRoll = 0;
    const damageBefore = structuredClone(car.vehicle.damage);
    for (let tick = 1; tick <= 90; tick++) {
      const surfaceSample = {
        surfaceKind: spec.kind,
        gripMultiplier: spec.gripMultiplier,
        rollingDragMps2: spec.rollingDragMps2,
        hydroDragCoeff: spec.hydroDragCoeff,
        roughnessAmp: spec.roughnessAmp,
        roughnessFreq: spec.roughnessFreq,
        elevationM: 1.25,
        dhdx: 0,
        dhdz: 0,
        gradeSin: 0,
        camberSin: 0,
        waterDepthM: spec.kind === "water" ? 0.035 : 0,
        sandDepthM: spec.kind === "sand" ? 0.045 : 0,
      };
      const next = { ...car, z: car.z + 8 * STEP, speed: 8 };
      const nextVehicle = advanceVehicleState(
        car,
        next,
        { targetSpeed: 8, steer: 0 },
        STEP,
        { tick, surface: surfaceSample },
      );
      car = { ...next, vehicle: nextVehicle };
      assertAllFinite(car.vehicle);
      assert.deepEqual(car.vehicle.damage, damageBefore, "surface roughness never mutates vehicle.damage");
      peakHeave = Math.max(peakHeave, Math.abs(car.vehicle.suspension.heaveM));
      peakRoll = Math.max(peakRoll, Math.abs(car.vehicle.suspension.rollRad));
    }
    return { car, peakHeave, peakRoll };
  };

  const smoothRun = runSurfaceRig(SURFACE_SPECS.asphalt);
  const cobbleRun = runSurfaceRig(SURFACE_SPECS.cobble);
  const sandRun = runSurfaceRig(SURFACE_SPECS.sand);

  assert.equal(cobbleRun.car.vehicle.surface.kind, "cobble");
  assert.equal(sandRun.car.vehicle.surface.kind, "sand");
  assert.equal(sandRun.car.vehicle.surface.sandDepthM, 0.045);
  assert.ok(cobbleRun.peakHeave > smoothRun.peakHeave * 3, "cobble excites heave chatter over smooth asphalt");
  assert.ok(cobbleRun.peakRoll > smoothRun.peakRoll * 3, "cobble excites roll chatter over smooth asphalt");
  assert.ok(sandRun.peakHeave > smoothRun.peakHeave * 3, "sand excites suspension undulation");
  assert.ok(
    Object.values(cobbleRun.car.vehicle.suspension.wheelOffsetsM).every(
      (v) => Math.abs(v) <= PLAYER_VEHICLE.suspensionTravelM,
    ),
  );

  // 3. Uphill grade redistributes load rearward and biases pitch
  let climbCar = makeCar({ speed: 6 });
  const uphillSample = {
    surfaceKind: "asphalt",
    gripMultiplier: 1,
    rollingDragMps2: 0,
    hydroDragCoeff: 0,
    roughnessAmp: 0,
    roughnessFreq: 6,
    elevationM: 2.1,
    dhdx: 0,
    dhdz: 0.09,
    gradeSin: 0.09,
    camberSin: 0,
    waterDepthM: 0,
    sandDepthM: 0,
  };
  for (let tick = 1; tick <= 40; tick++) {
    const next = { ...climbCar, z: climbCar.z + 6 * STEP, y: climbCar.y + 6 * STEP * 0.09, speed: 6 };
    climbCar = {
      ...next,
      vehicle: advanceVehicleState(
        climbCar,
        next,
        { targetSpeed: 6, steer: 0 },
        STEP,
        { tick, surface: uphillSample },
      ),
    };
  }
  assert.equal(climbCar.vehicle.surface.gradePct, 9);
  assert.ok(
    climbCar.vehicle.wheelLoadsN.rearLeft > climbCar.vehicle.wheelLoadsN.frontLeft + 80,
    "climbing uphill shifts static wheel load toward rear axle",
  );
  assert.ok(climbCar.vehicle.suspension.pitchRad < -0.005, "uphill grade pitches suspension rearward");
});
