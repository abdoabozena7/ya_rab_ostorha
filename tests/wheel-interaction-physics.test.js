import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { overlaps, makeDiagonalRoad } from "../src/core/geometry.js";
import { METRO_CITY_CURBS, acceptCurbPose, surveyMetroCurb } from "../src/core/pako-curb.js";
import { SURFACE_SPECS } from "../src/core/city-surfaces.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import {
  integrateVehicle,
  resolveVehicleContact,
  vehicleProbe,
  vehicleVelocity,
} from "../src/core/vehicle.js";
import {
  advanceVehicleState,
  cloneVehicleState,
  createVehicleState,
} from "../src/core/vehicle-state.js";
import {
  WHEEL_SCRUB_MODE,
  applyScrapingContactResponse,
  computeCurbWheelScrub,
  computeWheelInteractionState,
  computeWheelWorldPositions,
  getActorImpactReaction,
  recordActorImpactReaction,
  stepActorImpactReaction,
} from "../src/core/wheel-interaction-physics.js";
import { World } from "../src/core/world.js";

const SCRUB_SPEC = Object.freeze({
  wheelbase: PLAYER_VEHICLE.wheelbaseM,
  maxSteer: PLAYER_VEHICLE.maxSteerRad,
  realisticDynamics: true,
  tireGripMps2: 8,
  contactResponse: "inelastic-slide-v1",
  wheelInteractionPhysics: WHEEL_SCRUB_MODE,
  massKg: PLAYER_VEHICLE.massKg,
});

const LEGACY_SLIDE_SPEC = Object.freeze({
  wheelbase: PLAYER_VEHICLE.wheelbaseM,
  maxSteer: PLAYER_VEHICLE.maxSteerRad,
  realisticDynamics: true,
  tireGripMps2: 8,
  contactResponse: "inelastic-slide-v1",
  massKg: PLAYER_VEHICLE.massKg,
});

function makeSuv(overrides = {}) {
  return {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    y: 0,
    heading: 0,
    speed: 10,
    steer: 0,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    maxSpeed: 24,
    spec: SCRUB_SPEC,
    vehicle: createVehicleState(),
    ...overrides,
  };
}

function assertFiniteDeep(value) {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `Expected finite number, got ${value}`);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) assertFiniteDeep(v);
  }
}

test("computeWheelWorldPositions and vehicle state interaction cloning stay finite and geometric", () => {
  const poseNorth = { x: 10, z: -20, heading: 0 };
  const wheelsNorth = computeWheelWorldPositions(poseNorth);
  assert.ok(Math.abs(wheelsNorth.frontLeft.x - (10 - PLAYER_VEHICLE.trackM / 2)) < 1e-9);
  assert.ok(Math.abs(wheelsNorth.frontRight.x - (10 + PLAYER_VEHICLE.trackM / 2)) < 1e-9);
  assert.ok(Math.abs(wheelsNorth.frontLeft.z - (-20 + PLAYER_VEHICLE.wheelbaseM / 2)) < 1e-9);
  assert.ok(Math.abs(wheelsNorth.rearRight.z - (-20 - PLAYER_VEHICLE.wheelbaseM / 2)) < 1e-9);

  const poseEast = { x: 0, z: 0, heading: Math.PI / 2 };
  const wheelsEast = computeWheelWorldPositions(poseEast);
  assert.ok(Math.abs(wheelsEast.frontLeft.x - PLAYER_VEHICLE.wheelbaseM / 2) < 1e-9);
  assert.ok(Math.abs(wheelsEast.frontLeft.z - PLAYER_VEHICLE.trackM / 2) < 1e-9);
  assert.ok(Math.abs(wheelsEast.frontRight.z - -PLAYER_VEHICLE.trackM / 2) < 1e-9);

  const state = createVehicleState();
  assertFiniteDeep(state);
  assert.equal("surface" in state, false);
  assert.equal(state.interaction.scraping.active, false);
  assert.equal(state.interaction.scraping.kind, "none");
  assert.equal(state.interaction.tireSmokeIntensity, 0);

  const cloned = cloneVehicleState(state);
  assert.deepEqual(cloned, state);
  cloned.interaction.wheels.frontLeft.scrubIntensity = 0.8;
  assert.equal(state.interaction.wheels.frontLeft.scrubIntensity, 0);
});

test("shallow curb grazing (~10 deg at 10 m/s) deflects yaw toward curb tangent, bleeds speed, kicks steering, and rolls asymmetrically", () => {
  const roads = [
    Object.freeze({ id: "north-ave", axis: "z", fixed: 0, min: -120, max: 120, width: 14, zone: "avenue" }),
  ];
  const curb = Object.freeze({
    sites: Object.freeze([
      Object.freeze({
        id: "north-ave:pos:0",
        roadId: "north-ave",
        axis: "z",
        side: 1,
        avenue: true,
        edge: 7,
        minX: -6.92,
        maxX: 9.38,
        minZ: -115,
        maxZ: 115,
      }),
      Object.freeze({
        id: "north-ave:neg:0",
        roadId: "north-ave",
        axis: "z",
        side: -1,
        avenue: true,
        edge: -7,
        minX: -9.38,
        maxX: 6.92,
        minZ: -115,
        maxZ: 115,
      }),
    ]),
  });

  const deg10 = (10 * Math.PI) / 180;
  // Right-side shallow graze: frontRight wheel sits ~0.18 m onto the +x stone curb lip.
  const beforeRight = makeSuv({ x: 6.18, z: 0, heading: deg10, speed: 10, steer: 0 });
  const proposedRight = integrateVehicle(beforeRight, { targetSpeed: 10, steer: 0 }, STEP);
  const scrubRight = computeCurbWheelScrub(beforeRight, proposedRight, curb, roads, STEP);

  assert.equal(scrubRight.active, true);
  assert.equal(scrubRight.kind, "curb");
  assert.equal(scrubRight.grazing, true);
  assert.equal(scrubRight.wheel, "frontRight");
  assert.equal(scrubRight.side, "right");
  assert.ok(Math.abs(scrubRight.attackAngleRad - deg10) < 0.02);
  assert.equal(scrubRight.normalX, -1);
  assert.equal(scrubRight.normalZ, 0);

  // Sidewall scrub drag bleeds speed and aligns heading toward 0 (curb tangent)
  assert.ok(scrubRight.adjustedPose.speed < proposedRight.speed, "sidewall scrub must bleed speed");
  assert.ok(
    scrubRight.adjustedPose.heading < proposedRight.heading && scrubRight.adjustedPose.heading > 0,
    `expected heading (${scrubRight.adjustedPose.heading}) to deflect toward 0 from ${proposedRight.heading}`,
  );
  assert.ok(scrubRight.steerKickRad < -0.02, `expected negative steerKickRad away from right curb, got ${scrubRight.steerKickRad}`);
  assert.ok(scrubRight.rollImpulse > 0, "right curb lift must produce positive rollImpulse");

  const stateRight = advanceVehicleState(
    beforeRight,
    scrubRight.adjustedPose,
    { targetSpeed: 10, steer: 0 },
    STEP,
    { tick: 1, curbScrub: scrubRight },
  );
  assert.equal(stateRight.interaction.scraping.kind, "curb");
  assert.equal(stateRight.interaction.scraping.active, true);
  assert.equal(stateRight.interaction.scraping.grazing, true);
  assert.ok(stateRight.suspension.rollRad > 0, "right curb grazing lifts right side (+rollRad)");
  assert.ok(stateRight.steeringWheelRad < 0, "steerKickRad feeds back into steeringWheelRad");
  assert.ok(stateRight.interaction.wheels.frontRight.scrubIntensity > 0.25);
  assertFiniteDeep(stateRight);

  // Symmetric mirror check on left curb (-x edge = -7)
  const beforeLeft = makeSuv({ x: -6.18, z: 0, heading: -deg10, speed: 10, steer: 0 });
  const proposedLeft = integrateVehicle(beforeLeft, { targetSpeed: 10, steer: 0 }, STEP);
  const scrubLeft = computeCurbWheelScrub(beforeLeft, proposedLeft, curb, roads, STEP);

  assert.equal(scrubLeft.active, true);
  assert.equal(scrubLeft.wheel, "frontLeft");
  assert.equal(scrubLeft.side, "left");
  assert.ok(scrubLeft.adjustedPose.heading > proposedLeft.heading && scrubLeft.adjustedPose.heading < 0);
  assert.ok(scrubLeft.steerKickRad > 0.02);
  assert.ok(scrubLeft.rollImpulse < 0);

  const stateLeft = advanceVehicleState(
    beforeLeft,
    scrubLeft.adjustedPose,
    { targetSpeed: 10, steer: 0 },
    STEP,
    { tick: 1, curbScrub: scrubLeft },
  );
  assert.ok(stateLeft.suspension.rollRad < 0, "left curb grazing lifts left side (-rollRad)");
  assert.ok(Math.abs(stateLeft.suspension.rollRad + stateRight.suspension.rollRad) < 1e-9);

  // Diagonal road curb support check
  const diagRoad = Object.freeze(
    makeDiagonalRoad({ id: "diag-ave", x1: 0, z1: 0, x2: 100, z2: 100, width: 14 }),
  );
  const diagWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [diagRoad],
    drivingRoads: [diagRoad],
    statics: [],
  };
  const diagCurb = surveyMetroCurb(diagWorld, METRO_CITY_CURBS);
  assert.ok(diagCurb?.sites?.length >= 2);
  const posSite = diagCurb.sites.find((s) => s.side === 1);
  // Place SUV near midpoint of diagonal road so frontLeft wheel touches +side (+leftOffset) curb lip
  const along = (posSite.alongMin + posSite.alongMax) * 0.5;
  const targetLeftOffset = posSite.edge - 0.82;
  const baseDiagX = diagRoad.x1 + along * diagRoad.ux - targetLeftOffset * diagRoad.uz;
  const baseDiagZ = diagRoad.z1 + along * diagRoad.uz + targetLeftOffset * diagRoad.ux;
  const beforeDiag = makeSuv({
    x: baseDiagX,
    z: baseDiagZ,
    heading: diagRoad.heading - deg10,
    speed: 9,
  });
  const afterDiag = integrateVehicle(beforeDiag, { targetSpeed: 9, steer: 0 }, STEP);
  const scrubDiag = computeCurbWheelScrub(beforeDiag, afterDiag, diagCurb, [diagRoad], STEP);
  assert.equal(scrubDiag.active, true);
  assert.equal(scrubDiag.grazing, true);
  assert.ok(scrubDiag.adjustedPose.heading > afterDiag.heading, "diagonal curb deflects heading back toward diagonal tangent");
});

test("steeper curb approach (~35 deg) climbs cleanly onto sidewalk without deflecting back into street", () => {
  const roads = [
    Object.freeze({ id: "east-ave", axis: "x", fixed: 0, min: -100, max: 100, width: 14, zone: "avenue" }),
  ];
  const curb = Object.freeze({
    mode: METRO_CITY_CURBS,
    sites: Object.freeze([
      Object.freeze({
        id: "east-ave:pos:0",
        roadId: "east-ave",
        axis: "x",
        side: 1,
        avenue: true,
        edge: 7,
        minX: -95,
        maxX: 95,
        minZ: -6.92,
        maxZ: 9.38,
      }),
    ]),
    courtyards: Object.freeze([]),
  });

  const deg35 = (35 * Math.PI) / 180;
  // Heading = pi/2 - 35deg moves +x and +z toward z=7 curb at a 35-degree attack angle
  const climbHeading = Math.PI / 2 - deg35;
  const beforeClimb = makeSuv({ x: 0, z: 5.75, y: 0, heading: climbHeading, speed: 6, steer: 0 });
  const afterStep = integrateVehicle(beforeClimb, { targetSpeed: 6, steer: 0 }, STEP);
  acceptCurbPose(curb, roads, afterStep);
  assert.ok(afterStep.y > 0.003, `expected acceptCurbPose to raise vehicle y (${afterStep.y}) onto curb ramp`);

  const climbScrub = computeCurbWheelScrub(beforeClimb, afterStep, curb, roads, STEP);
  assert.equal(climbScrub.active, true);
  assert.equal(climbScrub.kind, "curb");
  assert.equal(climbScrub.grazing, false);
  assert.ok(climbScrub.attackAngleRad >= 0.40);

  // Must NOT deflect heading back into the street
  assert.equal(climbScrub.adjustedPose.heading, afterStep.heading);
  // Step-up climb bleeds a realistic fraction of speed and triggers corner suspension jounce
  assert.ok(climbScrub.adjustedPose.speed < afterStep.speed);
  assert.ok(Math.abs(climbScrub.rollImpulse) > 0.1);
  assert.ok(climbScrub.pitchImpulse < -0.05, "front wheel hitting 14cm curb kicks nose upward");
  assert.ok(climbScrub.heaveImpulse < -0.05, "curb step injects heave jounce");
});

test("off-center sideswipe against wall and vehicle applies Coulomb friction, deflects heading away from scraped corner, and never overlaps", () => {
  const wall = {
    id: "concrete-wall",
    type: "static",
    x: 3.0,
    z: 0,
    width: 0.2,
    length: 80,
    heading: 0,
  };
  const approachHeading = 0.22; // ~12.6 deg angled rightward into x=2.90 wall face
  const basePose = {
    x: 1.52,
    z: 0,
    heading: approachHeading,
    speed: 12,
    steer: 0,
  };

  const legacyBefore = makeSuv({ ...basePose, spec: LEGACY_SLIDE_SPEC });
  const scrubBefore = makeSuv({ ...basePose, spec: SCRUB_SPEC });

  const proposedLegacy = integrateVehicle(legacyBefore, { targetSpeed: 12, steer: 0 }, STEP);
  const proposedScrub = integrateVehicle(scrubBefore, { targetSpeed: 12, steer: 0 }, STEP);

  const legacyContact = resolveVehicleContact(legacyBefore, proposedLegacy, wall, STEP);
  const scrubContact = resolveVehicleContact(scrubBefore, proposedScrub, wall, STEP);

  assert.ok(legacyContact && scrubContact);
  assert.equal(legacyContact.scraping, undefined, "legacy spec must not attach wheel-scrub metadata");
  assert.ok(scrubContact.scraping?.active);
  assert.equal(scrubContact.scraping.kind, "wall");
  assert.equal(scrubContact.scraping.wheel, "frontRight");
  assert.equal(scrubContact.scraping.side, "right");

  const vLegacy = vehicleVelocity(legacyContact.body);
  const vScrub = vehicleVelocity(scrubContact.body);
  const legacySpeedMag = Math.hypot(vLegacy.x, vLegacy.z);
  const scrubSpeedMag = Math.hypot(vScrub.x, vScrub.z);

  assert.ok(
    scrubSpeedMag < legacySpeedMag - 0.01,
    `expected Coulomb scraping speed (${scrubSpeedMag}) < frictionless slide (${legacySpeedMag})`,
  );
  assert.ok(scrubSpeedMag <= 12 + 1e-9, "scraping must never create kinetic energy");
  assert.equal(overlaps(scrubContact.body, wall), false);

  // Heading deflects LEFT (smaller heading, away from the right-side wall)
  assert.equal(legacyContact.body.heading, approachHeading);
  assert.ok(
    scrubContact.body.heading < approachHeading,
    `expected heading (${scrubContact.body.heading}) < initial (${approachHeading}) when frontRight scrapes right wall`,
  );

  // World contact point sits strictly on the SUV hull perimeter right beside the x=2.90 wall face
  const bodyCorners = [
    scrubContact.body.x + Math.cos(scrubContact.body.heading) * (scrubContact.body.width / 2) + Math.sin(scrubContact.body.heading) * (scrubContact.body.length / 2),
    scrubContact.body.z - Math.sin(scrubContact.body.heading) * (scrubContact.body.width / 2) + Math.cos(scrubContact.body.heading) * (scrubContact.body.length / 2),
  ];
  assert.ok(Math.hypot(scrubContact.scraping.worldX - bodyCorners[0], scrubContact.scraping.worldZ - bodyCorners[1]) < 1e-4);
  assert.ok(Math.abs(scrubContact.scraping.worldX - 2.9) < 0.045);
  assert.ok(scrubContact.scraping.worldZ > scrubContact.body.z + 1.5);

  const wallState = advanceVehicleState(
    scrubBefore,
    scrubContact.body,
    { targetSpeed: 12, steer: 0 },
    STEP,
    { tick: 1, contact: scrubContact },
  );
  assert.equal(wallState.interaction.scraping.active, true);
  assert.equal(wallState.interaction.scraping.kind, "wall");
  assert.equal(wallState.interaction.scraping.wheel, "frontRight");
  assert.ok(Math.abs(wallState.interaction.scraping.worldX - 2.9) < 0.045);
  assert.ok(
    wallState.interaction.scrapeSmokeIntensity > 0.35 && wallState.interaction.tireSmokeIntensity === 0,
    "high-speed straight scraping emits localized scrapeSmokeIntensity without false symmetric tireSmokeIntensity",
  );

  // Steered sideswipe + post-impact suspension yaw rebound must also suppress false symmetric cornerSmoke
  const steeredScrapeState = advanceVehicleState(
    scrubBefore,
    { ...scrubContact.body, steer: -0.22, chaseSlipRad: 0.14 },
    { targetSpeed: 10, steer: -0.22 },
    STEP,
    { tick: 2, contact: scrubContact },
  );
  assert.equal(
    steeredScrapeState.interaction.tireSmokeIntensity,
    0,
    "steered scraping contact must not trigger symmetric rear drift tireSmokeIntensity",
  );
  const reboundAfterPose = {
    ...scrubContact.body,
    heading: scrubContact.body.heading + 0.024,
    steer: -0.06,
    chaseSlipRad: 0.12,
  };
  const postImpactReboundState = computeWheelInteractionState(
    { ...scrubContact.body, vehicle: steeredScrapeState },
    reboundAfterPose,
    { targetSpeed: 10, steer: -0.06 },
    steeredScrapeState.suspension,
    steeredScrapeState.wheelLoadsN,
    { surface: SURFACE_SPECS.asphalt, dt: STEP },
  );
  assert.equal(
    postImpactReboundState.tireSmokeIntensity,
    0,
    "post-impact suspension yawPushRadS / lateralPushMps rebound must not fake symmetric rear drift smoke",
  );

  // Multi-step continuous wall scrape never overlaps and aligns smoothly toward parallel
  let car = { ...scrubContact.body, vehicle: wallState };
  for (let step = 2; step <= 20; step++) {
    const prop = integrateVehicle(car, { targetSpeed: 12, steer: 0 }, STEP);
    const c = resolveVehicleContact(car, prop, wall, STEP);
    const nextPose = c ? c.body : prop;
    assert.equal(overlaps(nextPose, wall), false, `step ${step} must not overlap wall`);
    const nextState = advanceVehicleState(car, nextPose, { targetSpeed: 12, steer: 0 }, STEP, {
      tick: step,
      contact: c,
    });
    car = { ...nextPose, vehicle: nextState };
  }
  assert.ok(car.heading < approachHeading * 0.65, `expected multi-step scrape to align heading (${car.heading})`);

  // Vehicle-vs-vehicle off-center sideswipe (frontLeft scraping a slower traffic car on the left)
  const trafficCar = {
    id: "traffic-sedan",
    type: "vehicle",
    x: -2.85,
    z: 1.2,
    width: 1.82,
    length: 4.4,
    heading: 0,
    speed: 3,
    spec: { massKg: 1450 },
  };
  const egoLeftBefore = makeSuv({
    x: -0.56,
    z: 0,
    heading: -0.22,
    speed: 11,
    steer: 0,
    spec: SCRUB_SPEC,
  });
  const egoLeftLegacy = makeSuv({ ...egoLeftBefore, spec: LEGACY_SLIDE_SPEC });
  const propVehScrub = integrateVehicle(egoLeftBefore, { targetSpeed: 11, steer: 0 }, STEP);
  const propVehLegacy = integrateVehicle(egoLeftLegacy, { targetSpeed: 11, steer: 0 }, STEP);

  const vehLegacyContact = resolveVehicleContact(egoLeftLegacy, propVehLegacy, trafficCar, STEP);
  const vehScrubContact = resolveVehicleContact(egoLeftBefore, propVehScrub, trafficCar, STEP);
  assert.ok(vehLegacyContact && vehScrubContact);
  assert.equal(vehScrubContact.scraping.kind, "vehicle");
  assert.equal(vehScrubContact.scraping.wheel, "frontLeft");
  assert.equal(overlaps(vehScrubContact.body, trafficCar), false);
  // Two-body momentum + Coulomb scraping reduces ego speed below initial speed with strictly positive friction loss & shear impulse
  // Two-body momentum + Coulomb scraping reduces ego speed below initial speed with strictly positive shared normal & shear impulses
  assert.ok(vehScrubContact.body.speed < egoLeftBefore.speed);
  assert.ok(vehScrubContact.sharedImpulse.normalImpulseNs > 100);
  assert.ok(vehScrubContact.sharedImpulse.shearImpulseNs > 10);
  // Deflects RIGHT (larger heading, away from left-side vehicle)
  assert.ok(vehScrubContact.body.heading > egoLeftBefore.heading);

  // VehicleProbe preserves wheelInteractionPhysics
  const probe = vehicleProbe(scrubBefore, 10);
  assert.equal(probe.spec.wheelInteractionPhysics, WHEEL_SCRUB_MODE);

  // Negative control: centered perpendicular head-on barrier hit preserves exact speed === 0 and stop position
  const headOnBefore = makeSuv({ x: 0, z: 0, heading: Math.PI / 2, speed: 20, steer: 0 });
  const barrier = {
    id: "perp-barrier",
    type: "static",
    kind: "barrier",
    x: 2.25,
    z: 0,
    heading: Math.PI / 2,
    length: 0.1,
    width: 8,
  };
  const headOnProposed = integrateVehicle(headOnBefore, { targetSpeed: 20, steer: 0 }, STEP);
  const headOnContact = resolveVehicleContact(headOnBefore, headOnProposed, barrier, STEP);
  assert.ok(headOnContact);
  assert.equal(headOnContact.body.speed, 0);
  assert.equal(headOnContact.body.heading, Math.PI / 2);
  assert.ok(Math.abs(headOnContact.body.x + 2.1 - (barrier.x - 0.05)) <= 1e-6);
  assert.equal(headOnContact.scraping.steerKickRad, 0);
  assert.equal(headOnContact.scraping.rollImpulse, 0);
  assert.equal(overlaps(headOnContact.body, barrier), false);

  // Direct applyScrapingContactResponse invocation on a legacy baseContact also works cleanly
  const directScraped = applyScrapingContactResponse(scrubBefore, legacyContact, wall, STEP);
  assert.equal(overlaps(directScraped.body, wall), false);
  assert.ok(directScraped.body.heading < approachHeading);
});

test("recordActorImpactReaction and stepActorImpactReaction rock struck vehicles via WeakMap without mutating actor keys", () => {
  const sedan = {
    id: "ambient-sedan-1",
    type: "vehicle",
    kind: "sedan",
    x: 4,
    z: 10,
    heading: 0,
    speed: 5,
    width: 1.82,
    length: 4.3,
  };
  const tuktuk = {
    id: "ambient-tuktuk-1",
    type: "vehicle",
    kind: "tuktuk",
    x: 8,
    z: 10,
    heading: 0,
    speed: 4,
    width: 1.35,
    length: 2.7,
  };

  const keysBefore = Object.keys(sedan);
  const symbolsBefore = Object.getOwnPropertySymbols(sedan);
  assert.equal(getActorImpactReaction(sedan).active, false);

  // Right-angled + scraping sideswipe onto sedan (normal pointing right + slightly forward)
  recordActorImpactReaction(sedan, {
    normalX: 0.92,
    normalZ: 0.39,
    closingSpeedMps: 3.4,
    tangentialSpeedMps: 8.5,
    egoMassKg: PLAYER_VEHICLE.massKg,
    tick: 10,
  });
  recordActorImpactReaction(tuktuk, {
    normalX: 0.92,
    normalZ: 0.39,
    closingSpeedMps: 3.4,
    tangentialSpeedMps: 8.5,
    egoMassKg: PLAYER_VEHICLE.massKg,
    tick: 10,
  });

  // Actor hidden class / own keys must remain 100% untouched
  assert.deepEqual(Object.keys(sedan), keysBefore);
  assert.deepEqual(Object.getOwnPropertySymbols(sedan), symbolsBefore);

  let peakSedanRoll = 0;
  let minSedanRoll = 0;
  let peakSedanPitch = 0;
  let peakTuktukRoll = 0;

  for (let i = 0; i < 180; i++) {
    const rSedan = stepActorImpactReaction(sedan, STEP);
    const rTuktuk = stepActorImpactReaction(tuktuk, STEP);
    assertFiniteDeep(rSedan);
    peakSedanRoll = Math.max(peakSedanRoll, rSedan.rollRad);
    minSedanRoll = Math.min(minSedanRoll, rSedan.rollRad);
    peakSedanPitch = Math.max(peakSedanPitch, Math.abs(rSedan.pitchRad));
    peakTuktukRoll = Math.max(peakTuktukRoll, rTuktuk.rollRad);
    assert.ok(Math.abs(rSedan.rollRad) <= 0.11 + 1e-9);
    assert.ok(Math.abs(rSedan.pitchRad) <= 0.08 + 1e-9);
  }

  assert.ok(peakSedanRoll > 0.03, `expected visible positive roll peak, got ${peakSedanRoll}`);
  assert.ok(minSedanRoll < -0.005, `expected underdamped counter-rocking < 0, got ${minSedanRoll}`);
  assert.ok(peakSedanPitch > 0.01, `expected pitch rocking, got ${peakSedanPitch}`);
  assert.ok(peakTuktukRoll > peakSedanRoll, "lighter tuktuk rocks further than sedan under equal collision speed");

  // Settles cleanly back to exact zero after ~3 seconds
  const settled = getActorImpactReaction(sedan);
  assert.equal(settled.active, false);
  assert.equal(settled.rollRad, 0);
  assert.equal(settled.pitchRad, 0);
  assert.equal(settled.heaveM, 0);
  assert.deepEqual(Object.keys(sedan), keysBefore);
});

test("high-slip dry drift and hard emergency braking emit tire smoke while water and sand suppress dry smoke", () => {
  // 1. High-slip dry drift / aggressive cornering on dry asphalt
  let dryDrift = makeSuv({ speed: 16, steer: 0.45 });
  let dryDriftState = dryDrift.vehicle;
  for (let i = 0; i < 20; i++) {
    const next = integrateVehicle(
      dryDrift,
      { targetSpeed: 16, steer: 0.45, surface: SURFACE_SPECS.asphalt },
      STEP,
    );
    dryDriftState = advanceVehicleState(
      dryDrift,
      next,
      { targetSpeed: 16, steer: 0.45 },
      STEP,
      { tick: i + 1, surface: SURFACE_SPECS.asphalt },
    );
    dryDrift = { ...next, vehicle: dryDriftState };
  }
  assert.ok(
    dryDriftState.interaction.tireSmokeIntensity > 0.3,
    `expected dry drift tireSmokeIntensity > 0.3, got ${dryDriftState.interaction.tireSmokeIntensity}`,
  );
  assert.ok(Math.abs(dryDriftState.interaction.wheels.frontLeft.slipAngleRad) > 0.05);

  // 2. Hard emergency braking at speed on dry asphalt
  const brakeBefore = makeSuv({ speed: 15, steer: 0 });
  const brakeAfter = integrateVehicle(
    brakeBefore,
    { targetSpeed: 0, steer: 0, surface: SURFACE_SPECS.asphalt },
    STEP,
  );
  const brakeState = advanceVehicleState(
    brakeBefore,
    brakeAfter,
    { targetSpeed: 0, steer: 0 },
    STEP,
    { tick: 1, surface: SURFACE_SPECS.asphalt },
  );
  assert.ok(
    brakeState.interaction.tireSmokeIntensity > 0.3,
    `expected hard braking tireSmokeIntensity > 0.3, got ${brakeState.interaction.tireSmokeIntensity}`,
  );
  assert.ok(brakeState.interaction.wheels.rearLeft.brakeLockSlip > 0.3);

  // 3. Wet water surface and sand surface suppress dry rubber tire smoke (0)
  let wetDrift = makeSuv({ speed: 16, steer: 0.45 });
  let wetDriftState = wetDrift.vehicle;
  for (let i = 0; i < 20; i++) {
    const next = integrateVehicle(
      wetDrift,
      { targetSpeed: 16, steer: 0.45, surface: SURFACE_SPECS.water },
      STEP,
    );
    wetDriftState = advanceVehicleState(
      wetDrift,
      next,
      { targetSpeed: 16, steer: 0.45 },
      STEP,
      { tick: i + 1, surface: SURFACE_SPECS.water },
    );
    wetDrift = { ...next, vehicle: wetDriftState };
  }
  assert.equal(wetDriftState.interaction.surfaceKind, "water");
  assert.equal(wetDriftState.interaction.tireSmokeIntensity, 0, "water surface must suppress dry tire smoke");

  const wetBrakeAfter = integrateVehicle(
    brakeBefore,
    { targetSpeed: 0, steer: 0, surface: SURFACE_SPECS.water },
    STEP,
  );
  const wetBrakeState = computeWheelInteractionState(
    brakeBefore,
    wetBrakeAfter,
    { targetSpeed: 0, brake: 1 },
    brakeState.suspension,
    brakeState.wheelLoadsN,
    { surface: SURFACE_SPECS.water, dt: STEP },
  );
  assert.equal(wetBrakeState.tireSmokeIntensity, 0);

  const sandDriftState = computeWheelInteractionState(
    dryDrift,
    { ...dryDrift, heading: dryDrift.heading + 0.02, chaseSlipRad: -0.14 },
    { targetSpeed: 16, steer: 0.45 },
    dryDriftState.suspension,
    dryDriftState.wheelLoadsN,
    { surface: SURFACE_SPECS.sand, dt: STEP },
  );
  assert.equal(sandDriftState.surfaceKind, "sand");
  assert.equal(sandDriftState.tireSmokeIntensity, 0, "sand surface must suppress dry tire smoke");

  // 4. Live Metro v5 World compatibility check when wheel-scrub-v1 is active on player.spec
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  world.player.spec = { ...world.player.spec, wheelInteractionPhysics: WHEEL_SCRUB_MODE };
  const parked = world.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  const theta = 0.1;
  Object.assign(world.player, {
    x: parked.x,
    z:
      parked.z -
      parked.width / 2 -
      (Math.sin(theta) * world.player.length / 2 + Math.cos(theta) * world.player.width / 2) -
      0.003,
    heading: Math.PI / 2 - theta,
    speed: 6,
    steer: 0,
    path: [],
  });
  world.command({ type: "drive", targetSpeed: 6, steer: 0 });
  world.step();
  assert.equal(world.player.vehicle.contact.hitId, parked.id);
  assert.ok(world.player.speed > 5);
  assert.ok(world.player.x > parked.x + 0.09);
  assert.equal(overlaps(world.player, parked), false);
  assert.equal(world.player.vehicle.interaction.scraping.active, true);
  for (let i = 0; i < 10; i++) world.step();
  assert.equal(world.player.vehicle.damage.impactCount, 1);
  assert.deepEqual(world.audit(), []);
});
