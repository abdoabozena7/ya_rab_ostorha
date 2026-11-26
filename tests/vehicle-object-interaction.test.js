import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { FixedClock } from "../src/core/clock.js";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { resolveVehicleContact } from "../src/core/vehicle.js";
import {
  DISPATCH_DAMAGE_FEEDBACK,
  applyGtaContact,
  getCivilianGtaSlip,
  setCivilianGtaImpulse,
} from "../src/core/pursuit-gta.js";
import {
  WHEEL_SCRUB_MODE,
  getActorImpactReaction,
} from "../src/core/wheel-interaction-physics.js";

test("live Metro City v5 enables wheel-scrub-v1 interaction profile, manual curb grazing deflection, and wheel-by-wheel curb climbing", () => {
  const worldGraze = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "curb-graze" }, "metro");
  assert.equal(worldGraze.config.interactionProfile, WHEEL_SCRUB_MODE);
  assert.equal(worldGraze.player.spec.wheelInteractionPhysics, WHEEL_SCRUB_MODE);
  assert.ok(worldGraze.curbs?.sites?.length > 50, "Metro City v5 surveys curb sites for manual driving");

  // Find a north-south avenue curb site with plenty of clear length
  const site = worldGraze.curbs.sites.find(
    (s) => s.axis === "z" && s.avenue && s.maxZ - s.minZ >= 35,
  );
  assert.ok(site, "avenue z-axis curb site exists");

  const startZ = (site.minZ + site.maxZ) * 0.5 - 10;
  // Position SUV right beside the curb edge at a shallow 8 deg grazing angle toward the curb
  const curbSide = site.side; // +1 means curb is at +X edge, -1 means -X edge
  const grazeAngle = curbSide * (8 * Math.PI / 180);
  worldGraze.player.x = site.edge - curbSide * (worldGraze.player.width * 0.5 - 0.04);
  worldGraze.player.z = startZ;
  worldGraze.player.heading = grazeAngle;
  worldGraze.player.speed = 10.5;
  worldGraze.command({ type: "drive", targetSpeed: 10.5, steer: 0 });

  let sawCurbScrub = false;
  for (let i = 0; i < 18; i++) {
    worldGraze.step();
    if (worldGraze.player.vehicle?.interaction?.scraping?.kind === "curb") {
      sawCurbScrub = true;
    }
  }
  assert.equal(sawCurbScrub, true, "shallow manual curb graze activates curb scraping telemetry");
  // Heading should have deflected back toward 0 (parallel to z-axis curb) rather than increasing past grazeAngle
  assert.ok(
    Math.abs(worldGraze.player.heading) < Math.abs(grazeAngle) - 0.004,
    `curb scrub deflects heading toward curb tangent (${worldGraze.player.heading.toFixed(4)} vs ${grazeAngle.toFixed(4)})`,
  );
  assert.ok(worldGraze.player.speed < 10.5, "curb sidewall scrub bleeds speed");

  // Steeper ~36 deg climb onto the same sidewalk climbs cleanly with per-wheel terrainOffsetsM
  const worldClimb = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "curb-climb" }, "metro");
  const climbAngle = curbSide * (36 * Math.PI / 180);
  worldClimb.player.x = site.edge - curbSide * 1.25;
  worldClimb.player.z = startZ;
  worldClimb.player.heading = climbAngle;
  worldClimb.player.speed = 6.5;
  worldClimb.command({ type: "drive", targetSpeed: 6.5, steer: curbSide * 0.25 });

  let sawWheelStep = false;
  for (let i = 0; i < 30; i++) {
    worldClimb.step();
    const offsets = worldClimb.player.vehicle?.suspension?.terrainOffsetsM;
    if (worldClimb.player.curbSupportId && offsets && Object.values(offsets).some((v) => Math.abs(v) > 0.005)) {
      sawWheelStep = true;
      break;
    }
  }
  assert.equal(sawWheelStep, true, "decisive steering climbs onto sidewalk with per-wheel terrainOffsetsM in manual City driving");
});

test("sideswiping a real City parked vehicle triggers Coulomb scraping friction, telemetry, and damped two-body vehicle rocking while replays preserve none default", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "sideswipe-car" }, "metro");
  const worldFrictionless = new World({
    cityVersion: 5,
    traffic: 0,
    pedestrians: 0,
    seed: "sideswipe-car",
    interactionProfile: "none",
  }, "metro");

  const parked = world.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  const parkedFrictionless = worldFrictionless.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  assert.ok(parked && parkedFrictionless, "real City parked vehicle exists");
  const keysBefore = Object.keys(parked);

  const theta = 0.14;
  const setupPose = (p, target) => {
    Object.assign(p, {
      x: target.x - 1.1,
      z: target.z - target.width / 2 -
        (Math.sin(theta) * p.length / 2 + Math.cos(theta) * p.width / 2) - 0.004,
      heading: Math.PI / 2 - theta,
      speed: 9.5,
      steer: 0,
      path: [],
    });
  };
  setupPose(world.player, parked);
  setupPose(worldFrictionless.player, parkedFrictionless);

  world.command({ type: "drive", targetSpeed: 9.5, steer: 0 });
  worldFrictionless.command({ type: "drive", targetSpeed: 9.5, steer: 0 });

  let sawVehicleScrape = false;
  let peakTargetRoll = 0;
  for (let i = 0; i < 16; i++) {
    world.step();
    worldFrictionless.step();
    const scr = world.player.vehicle?.interaction?.scraping;
    if (scr?.active && scr.kind === "vehicle" && Number.isFinite(scr.worldX)) {
      sawVehicleScrape = true;
    }
    const rx = getActorImpactReaction(parked);
    if (Math.abs(rx.rollRad) > peakTargetRoll) peakTargetRoll = Math.abs(rx.rollRad);
  }

  assert.equal(sawVehicleScrape, true, "sideswiping a vehicle populates active vehicle scraping telemetry");
  assert.ok(
    world.player.speed < worldFrictionless.player.speed - 0.08,
    `Coulomb scraping friction bleeds speed (${world.player.speed.toFixed(3)} < ${worldFrictionless.player.speed.toFixed(3)})`,
  );
  assert.ok(peakTargetRoll > 0.008, `sideswiped vehicle rocks physically on its suspension (peakRoll=${peakTargetRoll.toFixed(4)})`);
  assert.deepEqual(Object.keys(parked), keysBefore, "WeakMap reaction keeps target actor hidden class monomorphic");

  // Verify WorldView renders nearby parked car at its real world matrix (not [0,0,0]) and applies jolt rotation
  const view = new WorldView(world);
  view.sync(1);
  view.prepareFrame({ cameras: [] });
  const parkedProp = view.metroParked.find((p) => p.origSite === parked);
  assert.ok(parkedProp?.root, "nearby parked vehicle visual root is acquired");
  assert.ok(
    Math.abs(parkedProp.root.matrixWorld.elements[12] - parked.x) < 1e-3 &&
      Math.abs(parkedProp.root.matrixWorld.elements[14] - parked.z) < 1e-3,
    `parked vehicle matrixWorld sits at (${parked.x}, ${parked.z}), not origin`,
  );
  view.dispose();

  // Replay without interactionProfile disables curb/wheel-scrub physics cleanly
  const rawReplay = world.replay();
  delete rawReplay.config.interactionProfile;
  const restored = World.fromReplay(rawReplay);
  assert.equal(restored.curbs, null);
  assert.equal(restored.player.spec.wheelInteractionPhysics, undefined);
});

test("moving traffic actors receive live impact rocking reaction in World.update and scrape friction uses relative tangential speed", () => {
  // 1. Live moving traffic vehicle in World.update (verifies reaction is stored on real actor, not copyPose)
  const world = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "moving-traffic-jolt" }, "metro");
  const trafficCar = world.actors.find((a) => a !== world.player && a.type === "vehicle");
  assert.ok(trafficCar, "live moving traffic actor exists");

  // Place traffic car moving along +X at 6.0 m/s and ego sideswiping its left flank at 11.5 m/s
  Object.assign(trafficCar, {
    x: 0,
    z: -108.0,
    heading: Math.PI / 2,
    speed: 6.0,
    steer: 0,
    path: [{ x: -10, z: -108.0 }, { x: 80, z: -108.0 }],
    cursor: 0,
  });
  const theta = 0.14;
  Object.assign(world.player, {
    x: trafficCar.x - 1.0,
    z: trafficCar.z - trafficCar.width / 2 -
      (Math.sin(theta) * world.player.length / 2 + Math.cos(theta) * world.player.width / 2) - 0.004,
    heading: Math.PI / 2 - theta,
    speed: 11.5,
    steer: 0,
    path: [],
  });
  world.command({ type: "drive", targetSpeed: 11.5, steer: 0 });

  let peakMovingTrafficRoll = 0;
  for (let i = 0; i < 16; i++) {
    world.step();
    const rx = getActorImpactReaction(trafficCar);
    if (Math.abs(rx.rollRad) > peakMovingTrafficRoll) {
      peakMovingTrafficRoll = Math.abs(rx.rollRad);
    }
  }
  assert.ok(
    peakMovingTrafficRoll > 0.006,
    `real moving traffic actor receives visible impact roll reaction (peakRoll=${peakMovingTrafficRoll.toFixed(4)})`,
  );

  // 2. Relative tangential contact velocity: co-moving vs stationary vs oncoming
  const runRelativeCase = (obsSpeed, obsHeading) => {
    const w = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "rel-speed" }, "metro");
    const target = {
      id: "rel-target",
      type: "vehicle",
      x: 0,
      z: 0,
      width: 1.85,
      length: 4.3,
      heading: obsHeading,
      speed: obsSpeed,
    };
    const before = {
      ...w.player,
      x: -0.6,
      z: -(target.width / 2 + (Math.sin(theta) * w.player.length / 2 + Math.cos(theta) * w.player.width / 2) + 0.004),
      heading: Math.PI / 2 - theta,
      speed: 11.0,
    };
    const dt = 1 / 60;
    const proposed = {
      ...before,
      x: before.x + Math.sin(before.heading) * 11.0 * dt,
      z: before.z + Math.cos(before.heading) * 11.0 * dt,
    };
    w.staticIndex = new SpatialIndex([target]);
    Object.assign(w.player, before);
    w.command({ type: "drive", targetSpeed: 11.0, steer: 0 });
    w.step();
    return {
      scraping: w.player.vehicle?.interaction?.scraping,
      finalSpeed: w.player.speed,
      proposed,
    };
  };

  const stationaryCase = runRelativeCase(0, Math.PI / 2);
  const sameSpeedCase = runRelativeCase(11.0, Math.PI / 2);
  const oncomingCase = runRelativeCase(11.0, -Math.PI / 2);

  assert.ok(
    (sameSpeedCase.scraping?.tangentialSpeedMps ?? 99) < 0.6,
    `co-moving vehicle at matched speed has near-zero relative tangential slip (${sameSpeedCase.scraping?.tangentialSpeedMps})`,
  );
  assert.ok(
    (stationaryCase.scraping?.tangentialSpeedMps ?? 0) > 9.5 &&
      (stationaryCase.scraping?.tangentialSpeedMps ?? 0) < 12.0,
    `stationary vehicle uses ~11 m/s tangential slip (${stationaryCase.scraping?.tangentialSpeedMps})`,
  );
  assert.ok(
    (oncomingCase.scraping?.tangentialSpeedMps ?? 0) > 20.0,
    `oncoming vehicle doubles relative tangential slip > 20 m/s (${oncomingCase.scraping?.tangentialSpeedMps})`,
  );
  assert.ok(
    sameSpeedCase.finalSpeed > stationaryCase.finalSpeed,
    `co-moving rub loses less longitudinal speed than hitting stationary target (${sameSpeedCase.finalSpeed.toFixed(3)} > ${stationaryCase.finalSpeed.toFixed(3)})`,
  );

  // 3. Mirrored faster co-moving vehicles (target 20 m/s brushing ego 10 m/s on BOTH left and right sides) transfer identical forward momentum!
  const wFast = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "faster-momentum" }, "metro");
  const grazeTheta = 0.02;
  const dtStep = 1 / 60;
  const runFasterSide = (sideSign) => {
    const fastTarget = {
      id: `fast-target-${sideSign}`,
      type: "vehicle",
      x: 0,
      z: 0,
      width: 1.85,
      length: 4.3,
      heading: Math.PI / 2,
      speed: 20.0,
    };
    const sepZ =
      fastTarget.width / 2 +
      (Math.sin(grazeTheta) * wFast.player.length / 2 + Math.cos(grazeTheta) * wFast.player.width / 2) +
      0.001;
    const egoBefore = {
      ...wFast.player,
      x: -0.4,
      z: sideSign * sepZ,
      heading: Math.PI / 2 + sideSign * grazeTheta,
      speed: 10.0,
    };
    const egoProposed = {
      ...egoBefore,
      x: egoBefore.x + Math.sin(egoBefore.heading) * 10.0 * dtStep,
      z: egoBefore.z + Math.cos(egoBefore.heading) * 10.0 * dtStep,
    };
    return resolveVehicleContact(egoBefore, egoProposed, fastTarget, dtStep);
  };
  const rightSideFast = runFasterSide(-1);
  const leftSideFast = runFasterSide(1);
  assert.ok(rightSideFast?.scraping?.active && leftSideFast?.scraping?.active, "both mirrored sides activate scraping");
  assert.ok(
    rightSideFast.body.speed > 10.005 && leftSideFast.body.speed > 10.005,
    `both sides transfer forward momentum (${rightSideFast.body.speed.toFixed(5)}, ${leftSideFast.body.speed.toFixed(5)} > 10.0)`,
  );
  assert.ok(
    Math.abs(rightSideFast.body.speed - leftSideFast.body.speed) < 1e-9,
    `left vs right faster-car momentum transfer is symmetric (${rightSideFast.body.speed} vs ${leftSideFast.body.speed})`,
  );

  // 4. Parked vehicles physically displace and skew on impact and update WorldView matrixWorld
  const wParkedMove = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "parked-shove" }, "metro");
  const targetParked = wParkedMove.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  const origPx = targetParked.x;
  const origPz = targetParked.z;
  const origPh = targetParked.heading;
  const hitTheta = 0.26;
  Object.assign(wParkedMove.player, {
    x: targetParked.x - 1.2,
    z: targetParked.z - targetParked.width / 2 -
      (Math.sin(hitTheta) * wParkedMove.player.length / 2 + Math.cos(hitTheta) * wParkedMove.player.width / 2) - 0.01,
    heading: Math.PI / 2 - hitTheta,
    speed: 13.0,
    steer: 0,
    path: [],
  });
  wParkedMove.command({ type: "drive", targetSpeed: 13.0, steer: 0 });
  for (let i = 0; i < 18; i++) wParkedMove.step();
  const parkedDispM = Math.hypot(targetParked.x - origPx, targetParked.z - origPz);
  const parkedYawRad = Math.abs(targetParked.heading - origPh);
  assert.ok(
    parkedDispM > 0.01 && parkedYawRad > 0.004,
    `struck parked sedan physically skids and skews (disp=${parkedDispM.toFixed(4)} m, yaw=${parkedYawRad.toFixed(4)} rad)`,
  );
  const viewParked = new WorldView(wParkedMove);
  viewParked.sync(1);
  viewParked.prepareFrame({ cameras: [] });
  const parkedEntry = viewParked.metroParked.find((p) => p.origSite === targetParked);
  assert.ok(
    Math.abs(parkedEntry.root.matrixWorld.elements[12] - targetParked.x) < 1e-3 &&
      Math.abs(parkedEntry.root.matrixWorld.elements[14] - targetParked.z) < 1e-3,
    "WorldView renders displaced parked vehicle at its updated world coordinates",
  );
  viewParked.dispose();

  // 4. Struck moving traffic actor alters its physical trajectory (z lateral shift & heading yaw) vs un-struck twin
  const wControl = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "moving-shove-traj" }, "metro");
  const wShoved = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "moving-shove-traj" }, "metro");
  const ctrlCar = wControl.actors.find((a) => a !== wControl.player && a.type === "vehicle");
  const shovedCar = wShoved.actors.find((a) => a !== wShoved.player && a.type === "vehicle");
  const initTraffic = (c) =>
    Object.assign(c, {
      x: 0,
      z: -108.5,
      heading: Math.PI / 2,
      speed: 7.5,
      steer: 0,
      path: [{ x: -10, z: -108.5 }, { x: 100, z: -108.5 }],
      cursor: 0,
    });
  initTraffic(ctrlCar);
  initTraffic(shovedCar);
  // Park control player far away; drive wShoved.player into shovedCar's rear-left flank
  Object.assign(wControl.player, { x: -200, z: -200, speed: 0, path: [] });
  const impactAngle = 0.28;
  Object.assign(wShoved.player, {
    x: shovedCar.x - 1.2,
    z: shovedCar.z - shovedCar.width / 2 -
      (Math.sin(impactAngle) * wShoved.player.length / 2 + Math.cos(impactAngle) * wShoved.player.width / 2) - 0.01,
    heading: Math.PI / 2 - impactAngle,
    speed: 13.5,
    steer: 0,
    path: [],
  });
  wControl.command({ type: "drive", targetSpeed: 0, steer: 0 });
  wShoved.command({ type: "drive", targetSpeed: 13.5, steer: 0 });
  for (let i = 0; i < 18; i++) {
    wControl.step();
    wShoved.step();
  }
  const lateralShiftM = Math.abs(shovedCar.z - ctrlCar.z);
  const headingShiftRad = Math.abs(shovedCar.heading - ctrlCar.heading);
  assert.ok(
    lateralShiftM > 0.08 && headingShiftRad > 0.01,
    `struck moving traffic vehicle physically shifts trajectory (dz=${lateralShiftM.toFixed(3)} m, dHeading=${headingShiftRad.toFixed(4)} rad)`,
  );

  // 5. Traffic-initiated collision: stationary player (0 m/s) struck across a 1 cm gap by a vehicle approaching at 20 m/s!
  const wStat = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "stationary-player-hit" }, "metro");
  const striker = wStat.actors.find((a) => a !== wStat.player && a.type === "vehicle");
  const ph = wStat.player.heading;
  wStat.player.speed = 0;
  wStat.player.steer = 0;
  wStat.player.path = [];
  // Place striker 1 cm behind stationary player's rear bumper on the same real road lane moving at +20 m/s
  const rearSep = wStat.player.length / 2 + striker.length / 2 + 0.01;
  Object.assign(striker, {
    x: wStat.player.x - Math.sin(ph) * rearSep,
    z: wStat.player.z - Math.cos(ph) * rearSep,
    heading: ph,
    speed: 20.0,
    maxSpeed: 22.0,
    steer: 0,
    path: [
      { x: wStat.player.x - Math.sin(ph) * 20, z: wStat.player.z - Math.cos(ph) * 20 },
      { x: wStat.player.x + Math.sin(ph) * 80, z: wStat.player.z + Math.cos(ph) * 80 },
    ],
    cursor: 0,
  });
  const directProbe = resolveVehicleContact(wStat.player, { ...wStat.player }, striker, 1 / 60);
  assert.ok(directProbe, "stationary player struck across 1 cm gap by 20 m/s vehicle triggers resolveVehicleContact");
  assert.ok(directProbe.closingSpeedMps > 19.5, `closingSpeedMps ~ 20 m/s (${directProbe.closingSpeedMps})`);
  assert.ok(directProbe.body.speed > 5.0, `stationary player receives physical forward shove (${directProbe.body.speed.toFixed(3)} m/s)`);

  wStat.command({ type: "drive", targetSpeed: 0, steer: 0 });
  wStat.step();
  assert.equal(wStat.player.vehicle.damage.impactCount, 1, "World.step records traffic-initiated impact on stationary player");
  assert.ok(wStat.player.speed > 4.0, `stationary player moves forward after rear-end impact (${wStat.player.speed.toFixed(3)} m/s)`);

  // 6. Equal-mass rear-end (20 m/s into 19 m/s), creeping (0.1 m/s rear-ended at 20 m/s), and head-on (+15 vs -15 m/s) conserve momentum & record damage!
  const wMom = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "shared-impulse-pairs" }, "metro");
  const otherCar = wMom.actors.find((a) => a !== wMom.player && a.type === "vehicle");
  otherCar.spec = { ...(otherCar.spec ?? {}), massKg: wMom.player.spec.massKg };
  const mh = wMom.player.heading;
  const sep = wMom.player.length / 2 + otherCar.length / 2 + 0.005;

  // 6a. Moving rear-end: equal-mass striker at 20 m/s into player at 19 m/s -> both converge to ~19.5 m/s!
  wMom.player.speed = 19.0;
  wMom.player.steer = 0;
  wMom.player.path = [];
  Object.assign(otherCar, {
    x: wMom.player.x - Math.sin(mh) * sep,
    z: wMom.player.z - Math.cos(mh) * sep,
    heading: mh,
    speed: 20.0,
    maxSpeed: 24.0,
    steer: 0,
    path: [
      { x: wMom.player.x - Math.sin(mh) * 20, z: wMom.player.z - Math.cos(mh) * 20 },
      { x: wMom.player.x + Math.sin(mh) * 80, z: wMom.player.z + Math.cos(mh) * 80 },
    ],
    cursor: 0,
  });
  const prop19 = {
    ...wMom.player,
    x: wMom.player.x + Math.sin(mh) * 19.0 * (1 / 60),
    z: wMom.player.z + Math.cos(mh) * 19.0 * (1 / 60),
  };
  const rear19 = resolveVehicleContact(wMom.player, prop19, otherCar, 1 / 60);
  assert.ok(rear19, "20 m/s into 19 m/s rear-end resolves contact");
  assert.ok(
    Math.abs(rear19.body.speed - 19.5) < 0.05,
    `equal-mass 20 m/s rear-ending 19 m/s accelerates player to ~19.5 m/s (got ${rear19.body.speed.toFixed(4)})`,
  );
  wMom.command({ type: "drive", targetSpeed: 19.0, steer: 0 });
  wMom.step();
  assert.ok(
    Math.abs((wMom.player.speed + otherCar.speed) - 39.0) < 0.35,
    `shared impulse conserves two-body total speed (${wMom.player.speed.toFixed(2)} + ${otherCar.speed.toFixed(2)} ~ 39.0)`,
  );

  // 6b. Creeping player (0.1 m/s) rear-ended at 20 m/s records full rear crash damage!
  const wCreep = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "creep-hit" }, "metro");
  const creepStriker = wCreep.actors.find((a) => a !== wCreep.player && a.type === "vehicle");
  const ch = wCreep.player.heading;
  wCreep.player.speed = 0.1;
  wCreep.player.steer = 0;
  wCreep.player.path = [];
  Object.assign(creepStriker, {
    x: wCreep.player.x - Math.sin(ch) * sep,
    z: wCreep.player.z - Math.cos(ch) * sep,
    heading: ch,
    speed: 20.0,
    maxSpeed: 24.0,
    steer: 0,
    path: [
      { x: wCreep.player.x - Math.sin(ch) * 20, z: wCreep.player.z - Math.cos(ch) * 20 },
      { x: wCreep.player.x + Math.sin(ch) * 80, z: wCreep.player.z + Math.cos(ch) * 80 },
    ],
    cursor: 0,
  });
  wCreep.command({ type: "drive", targetSpeed: 0.1, steer: 0 });
  wCreep.step();
  assert.equal(wCreep.player.vehicle.damage.impactCount, 1, "creeping player (0.1 m/s) records rear crash damage");
  assert.ok(wCreep.player.vehicle.damage.rear > 0.3, `creeping player records substantial rear damage (${wCreep.player.vehicle.damage.rear})`);

  // 6c. Equal-1880kg head-on (+15 m/s vs -15 m/s) through FULL World.step() brings BOTH vehicles near 0 m/s (copyPose preserves spec & kind)!
  const wHeadOn = new World({ cityVersion: 5, traffic: 4, pedestrians: 0, seed: "headon-world-step" }, "metro");
  const oncoming = wHeadOn.actors.find((a) => a !== wHeadOn.player && a.type === "vehicle");
  oncoming.spec = { ...(oncoming.spec ?? {}), massKg: wHeadOn.player.spec.massKg };
  const hh = wHeadOn.player.heading;
  const hSep = wHeadOn.player.length / 2 + oncoming.length / 2 + 0.005;
  wHeadOn.player.speed = 15.0;
  wHeadOn.player.steer = 0;
  wHeadOn.player.path = [];
  Object.assign(oncoming, {
    x: wHeadOn.player.x + Math.sin(hh) * hSep,
    z: wHeadOn.player.z + Math.cos(hh) * hSep,
    heading: hh + Math.PI,
    speed: 15.0,
    maxSpeed: 24.0,
    steer: 0,
    path: [
      { x: wHeadOn.player.x + Math.sin(hh) * 20, z: wHeadOn.player.z + Math.cos(hh) * 20 },
      { x: wHeadOn.player.x - Math.sin(hh) * 80, z: wHeadOn.player.z - Math.cos(hh) * 80 },
    ],
    cursor: 0,
  });
  wHeadOn.command({ type: "drive", targetSpeed: 15.0, steer: 0 });
  wHeadOn.step();
  assert.ok(Math.abs(wHeadOn.player.speed) < 0.35, `World.step equal-1880kg head-on brings player near 0 m/s (got ${wHeadOn.player.speed.toFixed(3)})`);
  assert.ok(Math.abs(oncoming.speed) < 0.35, `World.step equal-1880kg head-on brings oncoming traffic near 0 m/s (got ${oncoming.speed.toFixed(3)})`);

  // 6d. Parked vehicle unified stiction & finite-mass breakaway: below 1.35 m/s holds static (0 skid), above 1.35 m/s shares finite-mass momentum!
  const parkedSep = wCreep.player.length / 2 + 4.16 / 2 + 0.005;
  const parkedProbe = {
    id: "parked-sedan-probe",
    type: "static",
    kind: "parked-vehicle",
    vehicleKind: "sedan",
    x: wCreep.player.x + Math.sin(ch) * parkedSep,
    z: wCreep.player.z + Math.cos(ch) * parkedSep,
    width: 1.82,
    length: 4.16,
    heading: ch,
  };
  const gentleEgo = { ...wCreep.player, speed: 1.0 };
  const gentleProp = {
    ...gentleEgo,
    x: gentleEgo.x + Math.sin(ch) * 1.0 * (1 / 60),
    z: gentleEgo.z + Math.cos(ch) * 1.0 * (1 / 60),
  };
  const gentleHit = resolveVehicleContact(gentleEgo, gentleProp, parkedProbe, 1 / 60);
  assert.equal(gentleHit.stictionBroken, false, "gentle 1.0 m/s nudge stays below 1.35 m/s parked tire stiction");
  assert.equal(gentleHit.sharedImpulse.ix, 0, "parked car receives 0 net translation impulse below stiction breakaway");
  assert.ok(Math.abs(gentleHit.body.speed) < 0.05, "ego stops against held parked tires below breakaway");

  const hardEgo = { ...wCreep.player, speed: 6.0 };
  const hardProp = {
    ...hardEgo,
    x: hardEgo.x + Math.sin(ch) * 6.0 * (1 / 60),
    z: hardEgo.z + Math.cos(ch) * 6.0 * (1 / 60),
  };
  const hardHit = resolveVehicleContact(hardEgo, hardProp, parkedProbe, 1 / 60);
  assert.equal(hardHit.stictionBroken, true, "6.0 m/s hit breaks parked tire stiction");
  assert.ok(hardHit.body.speed > 2.5 && hardHit.body.speed < 4.5, `ego retains finite-mass two-body carry-through speed after breakaway (got ${hardHit.body.speed.toFixed(3)} m/s)`);
  assert.ok(hardHit.sharedImpulse.actorNetNormalImpulseNs > 2000, "parked car receives finite-mass net normal impulse after ground-friction deduction");

  // 7. Displaced parked vehicle resets cleanly to exact initial pose across fresh World creation (template isolation)!
  const pResetTest = wCreep.statics.find((s) => s.kind === "parked-vehicle");
  const resetOrigPx = pResetTest.x;
  const resetOrigPz = pResetTest.z;
  pResetTest.x += 0.35;
  pResetTest.z -= 0.18;
  const wFresh = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "reset-clean" }, "metro");
  const pAfterReset = wFresh.statics.find((s) => s.id === pResetTest.id);
  assert.equal(pAfterReset.x, resetOrigPx, "fresh World restores displaced parked vehicle X");
  assert.equal(pAfterReset.z, resetOrigPz, "fresh World restores displaced parked vehicle Z");
});

test("pursuit-mode collisions apply shared two-body impulse & trajectory reaction to civilian vehicles (both player-hit and patrol-hit), and FixedClock retains stall backlog", () => {
  // 1. Pursuit player colliding off-center with a stationary civilian car transfers forward speed, lateral shove, yaw spin, and body rocking
  const wPursuit = new World({ cityVersion: 5, traffic: 6, pedestrians: 0, seed: "pursuit-two-body-civ" }, "metro");
  wPursuit.command({
    type: "street-pursuit-start",
    level: 3,
    variant: "gta",
    config: { ruleset: "dispatch-v1", damageFeedback: DISPATCH_DAMAGE_FEEDBACK },
  });
  wPursuit.command({ type: "mode", mode: "manual" });

  const civ = wPursuit.actors.find((a) => a !== wPursuit.player && a.type === "vehicle" && !wPursuit.pursuit.patrols.has(a));
  assert.ok(civ, "civilian vehicle present in pursuit world");
  const keysBefore = Object.keys(civ).sort();
  const h = wPursuit.player.heading;
  const sep = wPursuit.player.length / 2 + civ.length / 2 + 0.02;
  wPursuit.player.speed = 16.0;
  wPursuit.player.steer = 0;
  Object.assign(civ, {
    x: wPursuit.player.x + Math.sin(h) * sep + Math.cos(h) * 0.45,
    z: wPursuit.player.z + Math.cos(h) * sep - Math.sin(h) * 0.45,
    heading: h,
    speed: 0,
    steer: 0,
    path: [
      { x: wPursuit.player.x - Math.sin(h) * 10, z: wPursuit.player.z - Math.cos(h) * 10 },
      { x: wPursuit.player.x + Math.sin(h) * 90, z: wPursuit.player.z + Math.cos(h) * 90 },
    ],
    cursor: 0,
  });
  const civStartX = civ.x;
  const civStartZ = civ.z;
  const civStartH = civ.heading;
  wPursuit.command({ type: "pursuit-drive", action: { steer: 0, throttle: 1, brake: 0, gear: 1 } });
  wPursuit.step();
  assert.ok(
    civ.speed > 4.0,
    `pursuit collision must transfer physical forward velocity to civilian vehicle instead of zeroing speed (got ${civ.speed.toFixed(3)} m/s)`,
  );
  assert.ok(
    wPursuit.player.speed < 14.5,
    `pursuit collision decelerates player via two-body reaction (got ${wPursuit.player.speed.toFixed(3)} m/s)`,
  );
  assert.equal(getActorImpactReaction(civ).active, true, "civilian vehicle receives damped suspension impact reaction");
  for (let i = 0; i < 8; i++) wPursuit.step();
  const civMovedM = Math.hypot(civ.x - civStartX, civ.z - civStartZ);
  const civYawDelta = Math.abs(Math.atan2(Math.sin(civ.heading - civStartH), Math.cos(civ.heading - civStartH)));
  assert.ok(civMovedM > 0.35, `civilian vehicle advances along shoved pursuit trajectory (moved ${civMovedM.toFixed(3)} m)`);
  assert.ok(civYawDelta > 0.01, `off-center pursuit hit rotates civilian heading (${civYawDelta.toFixed(4)} rad)`);
  assert.equal("gtaSlipMps" in civ, false, "civilian slip impulse stored in WeakMap without mutating actor keys");
  assert.equal("gtaYawRate" in civ, false, "civilian yaw impulse stored in WeakMap without mutating actor keys");

  // 2. Patrol-vs-civilian pursuit collision also transfers two-body velocity & suspension reaction to the civilian vehicle
  const patrol = [...wPursuit.pursuit.patrols][0];
  const civ2 = wPursuit.actors.find((a) => a !== wPursuit.player && a !== civ && a.type === "vehicle" && !wPursuit.pursuit.patrols.has(a));
  assert.ok(patrol && civ2, "patrol and second civilian vehicle present");
  const ph = patrol.heading ?? 0;
  const pSep = patrol.length / 2 + civ2.length / 2 + 0.02;
  patrol.speed = 15.0;
  Object.assign(civ2, {
    x: patrol.x + Math.sin(ph) * pSep,
    z: patrol.z + Math.cos(ph) * pSep,
    heading: ph,
    speed: 0,
    steer: 0,
    path: [
      { x: patrol.x - Math.sin(ph) * 10, z: patrol.z - Math.cos(ph) * 10 },
      { x: patrol.x + Math.sin(ph) * 90, z: patrol.z + Math.cos(ph) * 90 },
    ],
    cursor: 0,
  });
  wPursuit.step();
  assert.ok(
    civ2.speed > 4.0,
    `patrol-vs-civilian pursuit collision transfers two-body velocity to civilian (got ${civ2.speed.toFixed(3)} m/s)`,
  );
  assert.equal(getActorImpactReaction(civ2).active, true, "patrol-struck civilian receives suspension jolt");

  // 2b. Consecutive pursuit collision preserves a civilian's existing lateral slip velocity (WeakMap lookup through motion.a / motion.next)
  const slideCiv = wPursuit.actors.find(
    (a) => a !== wPursuit.player && a !== civ && a !== civ2 && a.type === "vehicle" && !wPursuit.pursuit.patrols.has(a),
  );
  assert.ok(slideCiv, "third civilian vehicle present for consecutive slip test");
  Object.assign(slideCiv, { x: 0, z: 0, heading: 0, speed: 6.0, steer: 0 });
  setCivilianGtaImpulse(slideCiv, { speed: 6.0, gtaSlipMps: -4.0, gtaYawRate: 0.25 });
  const plannedNext = { ...slideCiv, x: slideCiv.x - 4.0 * STEP, z: slideCiv.z + 6.0 * STEP, speed: 6.0 };
  const civMotion = { a: slideCiv, next: plannedNext, stop: 1, impulse: null };
  const egoPose = { ...wPursuit.player, x: 0, z: -4.3, heading: 0, speed: 10.0 };
  const egoMotion = { a: wPursuit.player, next: egoPose, stop: 1, impulse: null };
  // Pure rear-end along +Z (normal = {x: 0, z: 1}): lateral component is 0, so slideCiv MUST retain its -4.0 m/s lateral velocity!
  applyGtaContact(wPursuit, egoMotion, civMotion, egoPose, plannedNext, { x: 0, z: 1 }, 4.0, true);
  assert.ok(civMotion.impulse, "consecutive rear-end produces civilian impulse");
  assert.ok(
    Math.abs(civMotion.impulse.gtaSlipMps - -4.0) < 0.05,
    `consecutive collision must preserve civilian incoming -4.0 m/s lateral slip (got ${civMotion.impulse.gtaSlipMps})`,
  );

  // 2c. Distant (>115 m) civilian vehicle with active slip integrates & damps on EVERY fixed tick in tactical v5 pursuit
  const wTactical = new World({ cityVersion: 5, traffic: 6, pedestrians: 0, seed: "distant-slip-tick" }, "metro");
  wTactical.command({
    type: "street-pursuit-start",
    level: 4,
    variant: "gta",
    config: { ruleset: "dispatch-v1", tacticalPursuit: "gta-tactical-v1", damageFeedback: DISPATCH_DAMAGE_FEEDBACK },
  });
  wTactical.command({ type: "mode", mode: "manual" });
  const farCiv = wTactical.actors.find(
    (a) => a !== wTactical.player && a.type === "vehicle" && !wTactical.pursuit.patrols.has(a),
  );
  Object.assign(wTactical.player, { x: -250, z: -109.3, speed: 0 });
  Object.assign(farCiv, { x: 120, z: 109.3, heading: Math.PI / 2, speed: 0, path: [{ x: 100, z: 109.3 }, { x: 160, z: 109.3 }], cursor: 0 });
  setCivilianGtaImpulse(farCiv, { speed: 0, gtaSlipMps: 3.5, gtaYawRate: 0 });
  let prevSlip = getCivilianGtaSlip(farCiv).slipMps;
  for (let t = 0; t < 6; t++) {
    wTactical.step();
    const curSlip = getCivilianGtaSlip(farCiv)?.slipMps ?? 0;
    assert.ok(curSlip < prevSlip - 0.05, `tick ${t + 1}: distant civilian slip damps every fixed tick (${prevSlip.toFixed(3)} -> ${curSlip.toFixed(3)})`);
    prevSlip = curSlip;
  }
  assert.ok(getCivilianGtaSlip(farCiv) !== null, "civilian still has residual slip before pursuit stops");
  wTactical.command({ type: "street-pursuit-stop" });
  assert.equal(getCivilianGtaSlip(farCiv), null, "stopping pursuit clears civilian GTA slip cleanly so stale slip never leaks across stop/restart");

  // 3. FixedClock stall-and-recovery regression inside unit_regressions receipt (260 ms + 650 ms stalls retain 100% backlog, 0 discarded)
  const recoveryClock = new FixedClock();
  let recoveryTicks = 0;
  let totalElapsedS = 0;
  const stepFn = () => { recoveryTicks++; };
  totalElapsedS += 0.26;
  assert.equal(recoveryClock.advance(0.26, stepFn, 5), 5);
  for (let i = 0; i < 119; i++) {
    const dt = i === 40 ? 0.65 : (1 / 72);
    totalElapsedS += dt;
    recoveryClock.advance(dt, stepFn, 5);
  }
  assert.equal(recoveryClock.discardedSeconds, 0, "FixedClock must retain stall backlog with 0 discarded seconds");
  assert.equal(recoveryTicks, Math.floor((totalElapsedS + 1e-10) / STEP));
});


