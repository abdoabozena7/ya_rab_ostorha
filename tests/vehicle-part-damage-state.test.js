import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import {
  VEHICLE_PART_IDS,
  createPartDamageState,
  createVehicleState,
  advanceVehicleState,
  summarizeDamagedParts,
} from "../src/core/vehicle-state.js";

function makeActor(overrides = {}) {
  return {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    speed: 6,
    steer: 0,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    vehicle: createVehicleState(),
    ...overrides,
  };
}

function stepContact(before, {
  side = "front",
  closingSpeedMps = 6,
  energyJ = 0.5 * PLAYER_VEHICLE.massKg * closingSpeedMps ** 2,
  hitId = "obstacle-1",
  tick = 1,
  lateralOffsetM,
  longitudinalOffsetM,
  otherX,
  otherZ,
  normal,
  afterOverrides = {},
} = {}) {
  const after = {
    ...before,
    speed: 0,
    z: before.z + 0.05,
    ...afterOverrides,
  };
  const contact = {
    hitId,
    side,
    closingSpeedMps,
    energyJ,
    proposedTravelM: 0.1,
    ...(lateralOffsetM !== undefined ? { lateralOffsetM } : {}),
    ...(longitudinalOffsetM !== undefined ? { longitudinalOffsetM } : {}),
    ...(otherX !== undefined ? { otherX } : {}),
    ...(otherZ !== undefined ? { otherZ } : {}),
    ...(normal !== undefined ? { normal } : {}),
  };
  const nextVehicle = advanceVehicleState(
    before,
    after,
    { targetSpeed: before.speed, steer: 0 },
    STEP,
    { tick, contact },
  );
  return { ...after, vehicle: nextVehicle };
}

test("pristine createVehicleState initializes all 17 physical parts intact and deep-clones safely", () => {
  assert.equal(Object.isFrozen(VEHICLE_PART_IDS), true);
  assert.equal(VEHICLE_PART_IDS.length, 17);

  const state = createVehicleState();
  const { damage } = state;
  assert.equal(damage.brokenCount, 0);
  assert.equal(damage.detachedCount, 0);
  assert.equal(damage.impactCount, 0);
  assert.equal(damage.lastImpact, null);
  assert.deepEqual(Object.keys(damage.parts), [...VEHICLE_PART_IDS]);

  for (const id of VEHICLE_PART_IDS) {
    assert.equal(damage.parts[id].damage, 0, `${id} starts with 0 damage`);
    assert.equal(damage.parts[id].state, "intact", `${id} starts intact`);
    if ("detached" in damage.parts[id]) {
      assert.equal(damage.parts[id].detached, false);
    }
  }
  assert.deepEqual(summarizeDamagedParts(damage), []);
  assert.deepEqual(structuredClone(state), state);

  const actor = makeActor({ vehicle: state });
  const moved = advanceVehicleState(
    actor,
    { ...actor, z: 0.1 },
    { targetSpeed: 6, steer: 0 },
    STEP,
    { tick: 2 },
  );
  assert.deepEqual(moved.damage, createPartDamageState() && state.damage);
  assert.notEqual(moved.damage.parts, state.damage.parts);
  assert.notEqual(moved.damage.parts.hood, state.damage.parts.hood);
  moved.damage.parts.hood.damage = 0.9;
  assert.equal(state.damage.parts.hood.damage, 0, "mutating advanced state never aliases previous parts");
});

test("asymmetric front-left impact shatters left headlamp and unclips left bumper while sparing right side", () => {
  const actor = makeActor({ speed: 5.5 });
  const struck = stepContact(actor, {
    side: "front",
    closingSpeedMps: 5.5,
    lateralOffsetM: -0.68,
    tick: 12,
  });
  const { damage } = struck.vehicle;
  const { parts, lastImpact } = damage;

  assert.equal(lastImpact.side, "front");
  assert.equal(lastImpact.lateralOffsetM, -0.68);
  assert.equal(lastImpact.longitudinalOffsetM, 0);
  assert.equal(lastImpact.shatteredGlass, true);

  assert.equal(parts.headlampLeft.shattered, true);
  assert.equal(parts.headlampLeft.state, "shattered");
  assert.equal(parts.headlampRight.shattered, false);
  assert.ok(
    parts.headlampRight.damage < parts.headlampLeft.damage * 0.4,
    `expected right headlamp (${parts.headlampRight.damage}) << left headlamp (${parts.headlampLeft.damage})`,
  );

  assert.equal(parts.frontBumper.unclippedLeft, true);
  assert.equal(parts.frontBumper.unclippedRight, false);
  assert.equal(parts.frontBumper.state, "unclipped");

  assert.equal(parts.mirrorLeft.dangling, true);
  assert.equal(parts.mirrorRight.state, "intact");
  assert.ok(summarizeDamagedParts(damage).includes("Left headlamp shattered"));
  assert.ok(summarizeDamagedParts(damage).includes("Front bumper unclipped"));

  // Deriving localized coordinates from world obstacle position produces matching right-corner bias.
  const rightCorner = stepContact(makeActor({ speed: 5.5, x: 10, z: 20, heading: 0 }), {
    side: "front",
    closingSpeedMps: 5.5,
    otherX: 10.72,
    otherZ: 22.1,
    afterOverrides: { x: 10, z: 20.05, heading: 0 },
  });
  assert.equal(rightCorner.vehicle.damage.lastImpact.lateralOffsetM, 0.72);
  assert.equal(rightCorner.vehicle.damage.parts.headlampRight.shattered, true);
  assert.equal(rightCorner.vehicle.damage.parts.headlampLeft.shattered, false);
  assert.equal(rightCorner.vehicle.damage.parts.frontBumper.unclippedRight, true);
  assert.equal(rightCorner.vehicle.damage.parts.frontBumper.unclippedLeft, false);
});

test("6 m/s standard frontal impact vs 15 m/s heavy crash scales part detachment and keeps held ticks stationary", () => {
  const moderate = stepContact(makeActor({ speed: 6 }), {
    side: "front",
    closingSpeedMps: 6,
    tick: 10,
  });
  const modDamage = moderate.vehicle.damage;
  assert.equal(modDamage.parts.frontBumper.unclippedLeft, true);
  assert.equal(modDamage.parts.frontBumper.detached, false);
  assert.equal(modDamage.parts.hood.unlatched, true);
  assert.equal(modDamage.parts.hood.detached, false);
  assert.equal(modDamage.parts.headlampLeft.shattered, true);
  assert.equal(modDamage.parts.headlampRight.shattered, true);
  assert.equal(modDamage.detachedCount, 0);
  assert.deepEqual(modDamage.lastImpact.detachedParts, []);

  const heavy = stepContact(makeActor({ speed: 15 }), {
    side: "front",
    closingSpeedMps: 15,
    hitId: "wall-heavy",
    tick: 20,
  });
  const heavyDamage = heavy.vehicle.damage;
  assert.equal(heavyDamage.parts.hood.unlatched, true);
  assert.equal(heavyDamage.parts.hood.detached, true);
  assert.equal(heavyDamage.parts.hood.state, "detached");
  assert.equal(heavyDamage.parts.frontBumper.unclippedLeft, true);
  assert.equal(heavyDamage.parts.frontBumper.unclippedRight, true);
  assert.equal(heavyDamage.parts.frontBumper.detached, false);
  assert.equal(heavyDamage.parts.frontBumper.state, "crushed");
  assert.equal(heavyDamage.parts.grille.detached, true);
  assert.equal(heavyDamage.parts.headlampLeft.shattered, true);
  assert.equal(heavyDamage.parts.headlampRight.shattered, true);
  assert.equal(heavyDamage.parts.windshield.cracked, true);
  assert.equal(heavyDamage.parts.windshield.shattered, true);
  assert.equal(heavyDamage.parts.radiator.leaking, true);
  assert.equal(heavyDamage.parts.radiator.state, "leaking");
  assert.ok(heavyDamage.detachedCount >= 2);
  assert.deepEqual(heavyDamage.lastImpact.detachedParts, ["hood", "grille"]);
  assert.equal(heavyDamage.lastImpact.tick, 20);

  // Held contact on subsequent tick must keep damage 100% deepEqual (stationary invariant).
  const snapshotAtImpact = structuredClone(heavyDamage);
  const heldVehicle = advanceVehicleState(
    heavy,
    heavy,
    { targetSpeed: 0, steer: 0 },
    STEP,
    {
      tick: 21,
      contact: {
        hitId: "wall-heavy",
        side: "front",
        closingSpeedMps: 0,
        energyJ: 0,
        proposedTravelM: 0,
      },
    },
  );
  assert.deepEqual(heldVehicle.damage, snapshotAtImpact);

  // A subsequent fresh minor bump on another side must NOT re-report already-detached front parts.
  const separated = { ...heavy, z: heavy.z - 1, speed: -2, vehicle: heldVehicle };
  const lightRearTap = stepContact(separated, {
    side: "rear",
    closingSpeedMps: 2,
    hitId: "bollards",
    tick: 40,
    afterOverrides: { z: separated.z - 0.05 },
  });
  assert.equal(lightRearTap.vehicle.damage.lastImpact.tick, 40);
  assert.deepEqual(
    lightRearTap.vehicle.damage.lastImpact.detachedParts,
    [],
    "detachedParts in lastImpact only lists parts newly detached on that fresh impact tick",
  );
  assert.equal(lightRearTap.vehicle.damage.detachedCount, heavyDamage.detachedCount);
});

test("left side swipe dangles/detaches left mirror and pops left door ajar without touching right side", () => {
  const glancing = stepContact(makeActor({ speed: 3.5 }), {
    side: "left",
    closingSpeedMps: 3.5,
    hitId: "side-rail-1",
    tick: 5,
  });
  assert.equal(glancing.vehicle.damage.parts.mirrorLeft.dangling, true);
  assert.equal(glancing.vehicle.damage.parts.mirrorLeft.detached, false);
  assert.equal(glancing.vehicle.damage.parts.mirrorLeft.state, "dangling");
  assert.equal(glancing.vehicle.damage.parts.mirrorRight.state, "intact");
  assert.equal(glancing.vehicle.damage.parts.doorRight.state, "intact");

  const swipe = stepContact(makeActor({ speed: 6 }), {
    side: "left",
    closingSpeedMps: 6,
    longitudinalOffsetM: 0.9,
    hitId: "side-rail-2",
    tick: 9,
  });
  const { parts } = swipe.vehicle.damage;
  assert.equal(parts.mirrorLeft.detached, true);
  assert.equal(parts.mirrorLeft.state, "detached");
  assert.equal(parts.doorLeft.ajar, true);
  assert.equal(parts.doorLeft.claddingLoose, true);
  assert.equal(parts.doorLeft.state, "ajar");
  assert.equal(parts.headlampLeft.cracked, true);
  assert.equal(parts.frontBumper.unclippedLeft, true);
  assert.equal(parts.frontBumper.unclippedRight, false);
  assert.equal(parts.windshield.cracked, true, "heavy T-bone/side impact cracks windshield");

  assert.equal(parts.mirrorRight.damage, 0);
  assert.equal(parts.mirrorRight.state, "intact");
  assert.equal(parts.doorRight.damage, 0);
  assert.equal(parts.doorRight.state, "intact");
});

test("rear police ram tilts/detaches spare carrier, cracks rear glass, shatters tail lamps, and sags exhaust", () => {
  const parked = makeActor({ speed: 0 });
  const after = { ...parked, z: parked.z + 0.2, speed: 4 };
  const moderateVehicle = advanceVehicleState(
    parked,
    after,
    { targetSpeed: 0, steer: 0 },
    STEP,
    {
      tick: 14,
      freshImpacts: [
        { side: "rear", closingSpeedMps: 5, energyJ: 22500 },
      ],
    },
  );
  assert.equal(moderateVehicle.damage.parts.spareCarrier.tilted, true);
  assert.equal(moderateVehicle.damage.parts.spareCarrier.detached, false);
  assert.equal(moderateVehicle.damage.parts.spareCarrier.state, "tilted");
  assert.equal(moderateVehicle.damage.parts.rearHatch.glassCracked, true);
  assert.equal(moderateVehicle.damage.parts.tailLampLeft.shattered, true);
  assert.equal(moderateVehicle.damage.parts.tailLampRight.shattered, true);
  assert.equal(moderateVehicle.damage.parts.exhaust.sagging, true);
  assert.equal(moderateVehicle.damage.parts.exhaust.state, "sagging");

  const heavyRearVehicle = advanceVehicleState(
    parked,
    after,
    { targetSpeed: 0, steer: 0 },
    STEP,
    {
      tick: 15,
      freshImpacts: [
        { side: "rear", closingSpeedMps: 10, energyJ: 45000 },
      ],
    },
  );
  const rearParts = heavyRearVehicle.damage.parts;
  assert.equal(rearParts.spareCarrier.tilted, true);
  assert.equal(rearParts.spareCarrier.detached, true);
  assert.equal(rearParts.spareCarrier.state, "detached");
  assert.equal(rearParts.rearHatch.ajar, true);
  assert.equal(rearParts.rearHatch.glassCracked, true);
  assert.equal(rearParts.tailLampLeft.shattered, true);
  assert.equal(rearParts.tailLampRight.shattered, true);
  assert.equal(rearParts.exhaust.sagging, true);
  assert.ok(heavyRearVehicle.damage.lastImpact.detachedParts.includes("spareCarrier"));
  assert.equal(heavyRearVehicle.damage.lastImpact.shatteredGlass, true);

  const summary = summarizeDamagedParts(heavyRearVehicle.damage);
  assert.ok(summary.includes("Spare carrier detached"));
  assert.ok(summary.includes("Rear hatch ajar"));
  assert.ok(summary.includes("Left tail lamp shattered"));
  assert.ok(summary.includes("Exhaust sagging"));
});
