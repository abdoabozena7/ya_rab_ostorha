import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { distance, isDiagonalRoad, overlaps, pointOnRoad, roadPoseAt } from "../src/core/geometry.js";
import { METRO_CITY_CURBS, isPoseSupportedWithCurbs } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { gtaLineClear, updatePursuitResponse } from "../src/core/pursuit-response.js";
import { PAKO_EVASIVE_CONTROL } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/tactical-police-escape-20261123/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function loadBundledCheckpoint() {
  const checkpointPath = resolve(rootDir, "public/threejs/pako-chase-ppo.json");
  const raw = readFileSync(checkpointPath, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const json = JSON.parse(raw);
  const policy = freezePursuitPolicy(json);
  return { json, policy, sha256 };
}

function makeTacticalConfig(overrides = {}) {
  return {
    ruleset: "dispatch-v1",
    damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
    curbSupport: METRO_CITY_CURBS,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
    patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
    patrolChainYield: PATROL_LATERAL_YIELD,
    wantedLevelMax: 5,
    maxActivePatrols: 12,
    ...overrides,
  };
}

function findLongStraightAvenue(world) {
  return world.drivingRoads
    .filter(r => !r.parkingBay && !r.supportApron && !isDiagonalRoad(r) && (r.max - r.min) >= 500 && (r.width ?? 0) >= 11)
    .sort((a, b) => (b.max - b.min) - (a.max - a.min))[0];
}

function runStraightCatchupTrial({ tactical = true } = {}) {
  const world = new World({ cityVersion: 5, seed: "tactical-catchup-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  assert.ok(avenue, "Expected a long avenue in Grand City v5");
  const startAlong = avenue.min + 190;
  const egoStart = roadPoseAt(avenue, startAlong, 1);
  Object.assign(world.player, {
    x: egoStart.x,
    z: egoStart.z,
    heading: egoStart.heading,
    speed: 26,
    previous: { ...world.player, x: egoStart.x, z: egoStart.z, heading: egoStart.heading },
  });
  world.actorIndex = new SpatialIndex(world.actors);

  const cfg = makeTacticalConfig({
    maxActivePatrols: 1,
    enableRoadblocks: false,
    ...(tactical ? {} : { tacticalPursuit: undefined }),
  });
  if (!tactical) delete cfg.tacticalPursuit;

  world.command({ type: "street-pursuit-start", variant: "gta", level: 4, config: cfg }, false);
  const patrol = [...world.pursuit.patrols][0];
  const patrolStart = roadPoseAt(avenue, startAlong - 36, 1);
  Object.assign(patrol, {
    x: patrolStart.x,
    z: patrolStart.z,
    heading: patrolStart.heading,
    speed: 24,
    squadRole: "PRIMARY_CHASER",
    previous: { ...patrol, x: patrolStart.x, z: patrolStart.z, heading: patrolStart.heading },
  });
  if (tactical) {
    // Test interceptor / fast pursuit catch-up capability
    patrol.maxSpeed = Math.max(patrol.maxSpeed, 35.5);
  }
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);

  const initialGapM = distance(world.player, patrol);
  let minGapM = initialGapM;
  let maxPatrolSpeedMps = patrol.speed;
  let maxEgoSpeedMps = world.player.speed;

  for (let i = 0; i < 300 && world.pursuit?.phase === "running"; i++) {
    world.step({ steer: 0, throttle: 1, brake: 0, gear: 1 });
    if (world.pursuit?.patrols.has(patrol)) {
      minGapM = Math.min(minGapM, distance(world.player, patrol));
      maxPatrolSpeedMps = Math.max(maxPatrolSpeedMps, patrol.speed);
    }
    maxEgoSpeedMps = Math.max(maxEgoSpeedMps, world.player.speed);
  }

  const gapClosedM = Number((initialGapM - minGapM).toFixed(2));
  return {
    passed: maxPatrolSpeedMps > 32.3 && gapClosedM >= 5.5,
    initialGapM: Number(initialGapM.toFixed(2)),
    minGapM: Number(minGapM.toFixed(2)),
    gapClosedM,
    maxPatrolSpeedMps: Number(maxPatrolSpeedMps.toFixed(2)),
    maxEgoSpeedMps: Number(maxEgoSpeedMps.toFixed(2)),
  };
}

function runOffRoadPursuitTrial() {
  const world = new World({ cityVersion: 5, seed: "tactical-offroad-01", traffic: 0, pedestrians: 12 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const egoPose = roadPoseAt(avenue, (avenue.min + avenue.max) / 2, 1);
  Object.assign(world.player, {
    x: egoPose.x,
    z: egoPose.z,
    heading: egoPose.heading,
    speed: 10,
    previous: { ...world.player, ...egoPose },
  });
  world.actorIndex = new SpatialIndex(world.actors);

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 4,
    config: makeTacticalConfig({ maxActivePatrols: 2, enableRoadblocks: false }),
  }, false);

  const curb = world.pursuit.gta.curb;
  const courtyard = curb.courtyards?.find(cy => (cy.maxX - cy.minX) >= 9 && (cy.maxZ - cy.minZ) >= 9) ?? curb.courtyards?.[0];
  let offRoadTarget = null;
  if (courtyard) {
    const cand = {
      x: (courtyard.minX + courtyard.maxX) / 2,
      z: (courtyard.minZ + courtyard.maxZ) / 2,
      heading: 0,
      width: world.player.width,
      length: world.player.length,
    };
    if (
      isPoseSupportedWithCurbs(curb, world.roads, cand) &&
      !world.statics.some(s => overlaps(cand, s, 0.25))
    ) {
      offRoadTarget = cand;
    }
  }
  if (!offRoadTarget) {
    // Place ego on a surveyed sidewalk strip just outside asphalt
    const site = curb.sites[0];
    offRoadTarget = {
      x: (site.minX + site.maxX) / 2,
      z: (site.minZ + site.maxZ) / 2,
      heading: 0,
      width: world.player.width,
      length: world.player.length,
    };
  }

  Object.assign(world.player, {
    x: offRoadTarget.x,
    z: offRoadTarget.z,
    heading: offRoadTarget.heading,
    speed: 4,
    curbSupportId: "courtyard-cut",
    previous: { ...world.player, x: offRoadTarget.x, z: offRoadTarget.z },
  });

  // Place patrol on a nearby road 22..36 m away so it must route or cut across curb/courtyard toward off-road ego
  const nearRoad = world.drivingRoads
    .filter(r => !r.parkingBay && !r.supportApron && !isDiagonalRoad(r))
    .map(r => ({ r, pose: roadPoseAt(r, Math.min(r.max - 8, Math.max(r.min + 8, r.axis === "x" ? offRoadTarget.x : offRoadTarget.z)), 1) }))
    .filter(({ pose }) => {
      const d = distance(pose, offRoadTarget);
      return d >= 20 && !world.statics.some(s => overlaps({ ...pose, width: 1.9, length: 4.5 }, s, 0.3));
    })
    .sort((a, b) => distance(a.pose, offRoadTarget) - distance(b.pose, offRoadTarget))[0];

  const patrol = [...world.pursuit.patrols][0];
  Object.assign(patrol, {
    x: nearRoad.pose.x,
    z: nearRoad.pose.z,
    heading: nearRoad.pose.heading,
    speed: 8,
    path: [],
    cursor: 0,
    previous: { ...patrol, ...nearRoad.pose },
  });
  patrol.gtaAI.nextPlan = 0;
  world.actorIndex = new SpatialIndex(world.actors);
  // Force lastSeen to the off-road target so patrol must pursue/intercept an off-road coordinate!
  world.pursuit.response.lastSeen = Object.freeze({
    x: offRoadTarget.x,
    z: offRoadTarget.z,
    vx: 0,
    vz: 6,
    speed: 6,
    heading: 0,
    tick: world.tick,
    lastSeenTick: world.tick,
  });
  world.pursuit.response.unitsInContact = 1;
  world.pursuit.response.sightedBy.add(patrol);

  let patrolTravelM = 0;
  let usedCurbCount = 0;
  for (let i = 0; i < 150 && world.pursuit?.phase === "running"; i++) {
    const prev = { x: patrol.x, z: patrol.z };
    world.pursuit.response.unitsInContact = 1;
    world.pursuit.response.sightedBy.add(patrol);
    world.step({ steer: 0, throttle: 0, brake: 1, gear: 1 });
    if (world.pursuit?.patrols.has(patrol)) {
      patrolTravelM += Math.hypot(patrol.x - prev.x, patrol.z - prev.z);
      if (patrol.curbSupportId || !pointOnRoad(patrol, world.drivingRoads, 0.1)) usedCurbCount++;
    }
  }

  const pedHits = world.pursuit?.metrics.pedestrianCollisions ?? world.metrics.collisions;
  return {
    passed: patrolTravelM >= 14 && pedHits === 0,
    patrolTravelM: Number(patrolTravelM.toFixed(2)),
    usedCurbSteps: usedCurbCount,
    pedestrianHits: pedHits,
  };
}

function runLaneOvertakeTrial() {
  const world = new World({ cityVersion: 5, seed: "tactical-overtake-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const baseAlong = avenue.min + 220;
  const egoPose = roadPoseAt(avenue, baseAlong + 44, 1);
  Object.assign(world.player, {
    x: egoPose.x,
    z: egoPose.z,
    heading: egoPose.heading,
    speed: 24,
    previous: { ...world.player, ...egoPose },
  });

  // Add a parked/stopped civilian car directly in the right lane 24 m ahead between patrol and ego
  const blockerPose = roadPoseAt(avenue, baseAlong + 24, 1);
  const civilian = world.makeVehicle("slow-civilian-blocker", "sedan", blockerPose);
  civilian.speed = 0;
  civilian.maxSpeed = 0.1;
  civilian.path = [];
  world.actors.push(civilian);
  world.actorIndex = new SpatialIndex(world.actors);

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 3,
    config: makeTacticalConfig({ maxActivePatrols: 1, enableRoadblocks: false }),
  }, false);

  const patrol = [...world.pursuit.patrols][0];
  const patrolStart = roadPoseAt(avenue, baseAlong, 1);
  Object.assign(patrol, {
    x: patrolStart.x,
    z: patrolStart.z,
    heading: patrolStart.heading,
    speed: 18,
    previous: { ...patrol, ...patrolStart },
  });
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);

  let overtookBlocker = false;
  let sawOvertakeReason = false;
  for (let i = 0; i < 160 && world.pursuit?.phase === "running"; i++) {
    civilian.speed = 0;
    world.step({ steer: 0, throttle: 0.75, brake: 0, gear: 1 });
    if (patrol.reason === "tactical-overtake") sawOvertakeReason = true;
    const sin = Math.sin(blockerPose.heading), cos = Math.cos(blockerPose.heading);
    const forwardPast = (patrol.x - civilian.x) * sin + (patrol.z - civilian.z) * cos;
    if (forwardPast > 6.5) {
      overtookBlocker = true;
      break;
    }
  }

  return {
    passed: overtookBlocker,
    overtookBlocker,
    sawOvertakeReason,
    patrolSpeedAfterMps: Number((patrol.speed ?? 0).toFixed(2)),
  };
}

function runOpenRoadStarDecayTrial({ tactical = true } = {}) {
  const world = new World({ cityVersion: 5, seed: "tactical-decay-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const egoStart = roadPoseAt(avenue, avenue.min + 80, 1);
  Object.assign(world.player, {
    x: egoStart.x,
    z: egoStart.z,
    heading: egoStart.heading,
    speed: 18,
    previous: { ...world.player, ...egoStart },
  });
  world.actorIndex = new SpatialIndex(world.actors);

  const cfg = makeTacticalConfig({
    maxActivePatrols: 1,
    enableRoadblocks: false,
    episodeMaxSeconds: 120,
    ...(tactical ? {} : { tacticalPursuit: undefined }),
  });
  if (!tactical) delete cfg.tacticalPursuit;

  world.command({ type: "street-pursuit-start", variant: "gta", level: 3, config: cfg }, false);
  const patrol = [...world.pursuit.patrols][0];
  // First let patrol spot the player for 70 ticks so pursuit qualifies (`escapeEligible = true`)
  const closeSpot = roadPoseAt(avenue, avenue.min + 52, 1);
  Object.assign(patrol, { x: closeSpot.x, z: closeSpot.z, heading: closeSpot.heading, speed: 15, previous: { ...patrol, ...closeSpot } });
  world.actorIndex = new SpatialIndex(world.actors);
  for (let i = 0; i < 70; i++) {
    world.step({ steer: 0, throttle: 0.6, brake: 0, gear: 1 });
  }

  // Now move player far away (> 140 m) behind tall Grand City v5 buildings INSIDE surveillanceZones!
  const zone0 = world.district.surveillanceZones?.[0];
  const farRoad = world.drivingRoads.find(r => {
    if (r.parkingBay || r.supportApron || r.id === avenue.id || isDiagonalRoad(r)) return false;
    const mid = roadPoseAt(r, (r.min + r.max) / 2, 1);
    const inZone = zone0
      ? mid.x >= zone0.minX + 10 && mid.x <= zone0.maxX - 10 && mid.z >= zone0.minZ + 10 && mid.z <= zone0.maxZ - 10
      : true;
    return inZone && distance(mid, egoStart) >= 130;
  }) ?? world.drivingRoads.find(r => !r.parkingBay && !r.supportApron && r.id !== avenue.id && !isDiagonalRoad(r));
  const farPose = roadPoseAt(farRoad, (farRoad.min + farRoad.max) / 2, 1);
  Object.assign(world.player, {
    x: farPose.x,
    z: farPose.z,
    heading: farPose.heading,
    speed: 0,
    previous: { ...world.player, ...farPose },
  });
  // Keep patrol far away (> 220 m) on the south end of avenue out of LOS
  const farPatrol = roadPoseAt(avenue, avenue.min + 20, -1);
  Object.assign(patrol, {
    x: farPatrol.x,
    z: farPatrol.z,
    heading: farPatrol.heading,
    speed: 0,
    maxSpeed: 0.1,
    previous: { ...patrol, ...farPatrol },
  });
  world.actorIndex = new SpatialIndex(world.actors);

  const starSequence = [world.pursuit.wantedLevel];
  let escaped = false;
  let observedZoneTrackedTrap = false;

  for (let i = 0; i < 1100; i++) {
    patrol.x = farPatrol.x;
    patrol.z = farPatrol.z;
    patrol.speed = 0;
    world.step({ steer: 0, throttle: 0, brake: 1, gear: 1 });
    if (!world.pursuit || world.pursuit.phase !== "running") {
      if (world.pursuit?.phase === "escaped") {
        if (starSequence[starSequence.length - 1] !== 0) starSequence.push(0);
        escaped = true;
      }
      break;
    }
    if (world.pursuit.response?.dispatch?.state === "ZONE_TRACKED") {
      observedZoneTrackedTrap = true;
    }
    const curStar = world.pursuit.wantedLevel;
    if (curStar !== starSequence[starSequence.length - 1]) {
      starSequence.push(curStar);
    }
  }

  return {
    passed: escaped && starSequence.join("->") === "3->2->1->0" && !observedZoneTrackedTrap,
    escaped,
    starSequence,
    observedZoneTrackedTrap,
  };
}

function runCloseRangeNoDecayCheck() {
  const world = new World({ cityVersion: 5, seed: "tactical-close-guard-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const egoStart = roadPoseAt(avenue, avenue.min + 120, 1);
  Object.assign(world.player, { ...egoStart, speed: 12, previous: { ...world.player, ...egoStart } });
  world.actorIndex = new SpatialIndex(world.actors);

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 3,
    config: makeTacticalConfig({ maxActivePatrols: 1, enableRoadblocks: false }),
  }, false);

  const patrol = [...world.pursuit.patrols][0];
  // Place patrol 42 m away facing AWAY from player (so unitsInContact === 0, unseen!) while player drives on open asphalt (speed = 12 m/s, not hiding, < 86 m threshold!)
  const closeUnseen = roadPoseAt(avenue, avenue.min + 78, -1);
  for (let i = 0; i < 360 && world.pursuit?.phase === "running"; i++) {
    Object.assign(world.player, { ...egoStart, speed: 12 });
    Object.assign(patrol, { ...closeUnseen, speed: 0 });
    world.actorIndex = new SpatialIndex(world.actors);
    world.step({ steer: 0, throttle: 0.4, brake: 0, gear: 1 });
  }

  const starsStayedAt3 = world.pursuit?.wantedLevel === 3 && world.pursuit?.phase === "running";
  return {
    starsStayedAt3,
    wantedLevelAfter6s: world.pursuit?.wantedLevel ?? 0,
    dispatchState: world.pursuit?.response?.dispatch?.state ?? null,
  };
}

function runAlleyHideStarDecayTrial() {
  const world = new World({ cityVersion: 5, seed: "tactical-hide-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const egoStart = roadPoseAt(avenue, avenue.min + 140, 1);
  Object.assign(world.player, { ...egoStart, speed: 14, previous: { ...world.player, ...egoStart } });
  world.actorIndex = new SpatialIndex(world.actors);

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 2,
    config: makeTacticalConfig({ maxActivePatrols: 1, enableRoadblocks: false }),
  }, false);

  const patrol = [...world.pursuit.patrols][0];
  const spotPose = roadPoseAt(avenue, avenue.min + 112, 1);
  Object.assign(patrol, { ...spotPose, speed: 14, previous: { ...patrol, ...spotPose } });
  world.actorIndex = new SpatialIndex(world.actors);
  for (let i = 0; i < 66; i++) world.step({ steer: 0, throttle: 0.5, brake: 0, gear: 1 });

  // Now tuck ego into a courtyard/sidewalk behind a building at ~62 m from patrol (< 92 m open-road threshold, >= 52 m cover threshold!)
  const curb = world.pursuit.gta.curb;
  const cy = curb.courtyards?.find(c =>
    !world.statics.some(s => overlaps({ x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2, heading: 0, width: 2, length: 4.6 }, s, 0.25))
  );
  assert.ok(cy, "Expected clear courtyard for alley hide trial");
  const hideSpot = { x: (cy.minX + cy.maxX) / 2, z: (cy.minZ + cy.maxZ) / 2, heading: 0 };

  // Put lastSeen 45 m away and patrol 64 m away facing away/behind buildings so LOS is broken, yet < 92 m open-road distance!
  world.pursuit.response.lastSeen = Object.freeze({
    x: hideSpot.x + 44,
    z: hideSpot.z + 15,
    vx: 0,
    vz: 0,
    speed: 0,
    heading: 0,
    tick: world.tick,
    lastSeenTick: world.tick,
  });

  const patrolRoadPose = world.drivingRoads
    .filter(r => !r.parkingBay && !r.supportApron && !isDiagonalRoad(r))
    .flatMap(r => [
      roadPoseAt(r, r.min + 20, -1),
      roadPoseAt(r, r.min + 80, -1),
      roadPoseAt(r, (r.min + r.max) / 2, -1),
      roadPoseAt(r, r.max - 80, -1),
      roadPoseAt(r, r.max - 20, -1),
    ])
    .find(p => {
      const d = distance(p, hideSpot);
      return (
        d >= 56 &&
        d <= 82 &&
        !world.statics.some(s => overlaps({ ...p, width: 1.9, length: 4.5 }, s, 0.25)) &&
        !gtaLineClear(world, p, hideSpot.x - p.x, hideSpot.z - p.z, d)
      );
    });
  assert.ok(patrolRoadPose, "Expected building-occluded patrol berth 56..82 m from hide spot");

  let sawHiddenInCover = false;
  const starSequence = [world.pursuit.wantedLevel];
  let escaped = false;

  for (let i = 0; i < 800; i++) {
    Object.assign(world.player, { ...hideSpot, speed: 0, curbSupportId: cy.id });
    // Face patrol away from hideSpot so 132 deg cone doesn't spot if unoccluded
    const awayHeading = Math.atan2(patrolRoadPose.x - hideSpot.x, patrolRoadPose.z - hideSpot.z);
    Object.assign(patrol, { x: patrolRoadPose.x, z: patrolRoadPose.z, heading: awayHeading, speed: 0, maxSpeed: 0.1 });
    world.actorIndex = new SpatialIndex(world.actors);
    world.step({ steer: 0, throttle: 0, brake: 1, gear: 1 });
    if (!world.pursuit || world.pursuit.phase !== "running") {
      if (world.pursuit?.phase === "escaped") {
        if (starSequence[starSequence.length - 1] !== 0) starSequence.push(0);
        escaped = true;
      }
      break;
    }
    if (world.pursuit.response?.dispatch?.hiddenInCover) sawHiddenInCover = true;
    const cur = world.pursuit.wantedLevel;
    if (cur !== starSequence[starSequence.length - 1]) starSequence.push(cur);
  }

  return {
    passed: escaped && sawHiddenInCover && starSequence.join("->") === "2->1->0",
    escaped,
    sawHiddenInCover,
    starSequence,
    patrolDistanceM: Number(distance(patrolRoadPose, hideSpot).toFixed(1)),
  };
}

function runReacquireMidDecayTrial() {
  const world = new World({ cityVersion: 5, seed: "tactical-reacquire-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = findLongStraightAvenue(world);
  const egoStart = roadPoseAt(avenue, avenue.min + 260, 1);
  Object.assign(world.player, { ...egoStart, speed: 12, previous: { ...world.player, ...egoStart } });
  world.actorIndex = new SpatialIndex(world.actors);

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 3,
    config: makeTacticalConfig({ maxActivePatrols: 1, enableRoadblocks: false }),
  }, false);

  const patrol = [...world.pursuit.patrols][0];
  const closeSpot = roadPoseAt(avenue, avenue.min + 232, 1);
  Object.assign(patrol, { ...closeSpot, speed: 12, previous: { ...patrol, ...closeSpot } });
  world.actorIndex = new SpatialIndex(world.actors);
  for (let i = 0; i < 65; i++) world.step({ steer: 0, throttle: 0.4, brake: 0, gear: 1 });

  // Separate far out of sight until COOLING_DOWN starts and drops 3★ -> 2★
  const farPatrol = roadPoseAt(avenue, avenue.min + 20, -1);
  const farEgo = roadPoseAt(avenue, avenue.max - 40, 1);
  let enteredCooldown = false;
  for (let i = 0; i < 480 && world.pursuit?.phase === "running"; i++) {
    Object.assign(world.player, { ...farEgo, speed: 0 });
    Object.assign(patrol, { ...farPatrol, speed: 0 });
    world.actorIndex = new SpatialIndex(world.actors);
    world.step({ steer: 0, throttle: 0, brake: 1, gear: 1 });
    if (world.pursuit.response?.dispatch?.coolingDown && world.pursuit.wantedLevel === 2) {
      enteredCooldown = true;
      break;
    }
  }

  const cooldownStrobe = world.pursuit.response?.strobeIntensity ?? 1;
  // Now patrol spots ego directly at 28 m!
  const respotPose = roadPoseAt(avenue, avenue.max - 68, 1);
  Object.assign(patrol, { ...respotPose, heading: farEgo.heading, speed: 18 });
  world.actorIndex = new SpatialIndex(world.actors);
  world.step({ steer: 0, throttle: 0.5, brake: 0, gear: 1 });

  const dispatchAfter = world.pursuit.response?.dispatch;
  const hotStrobe = world.pursuit.response?.strobeIntensity ?? 0;

  return {
    passed:
      enteredCooldown &&
      cooldownStrobe <= 0.18 &&
      dispatchAfter?.coolingDown === false &&
      dispatchAfter?.state === "VISUALLY_SPOTTED" &&
      hotStrobe >= 0.55,
    enteredCooldown,
    cooldownStrobe: Number(cooldownStrobe.toFixed(3)),
    stateAfterRespot: dispatchAfter?.state ?? null,
    coolingDownAfterRespot: Boolean(dispatchAfter?.coolingDown),
    hotStrobeAfterRespot: Number(hotStrobe.toFixed(3)),
  };
}

function runRlTacticalSweep(policy, sha256) {
  const seeds = ["tactical-rl-01", "tactical-rl-02", "tactical-rl-03", "tactical-rl-04", "tactical-rl-05", "tactical-rl-06"];
  const runs = [];
  let totalPedestrianHits = 0;
  let stuckRuns = 0;

  for (const seed of seeds) {
    const world = new World({ cityVersion: 5, seed, traffic: 72, pedestrians: 120 }, "metro");
    world.command({
      type: "street-pursuit-start",
      variant: "gta",
      level: 5,
      config: makeTacticalConfig({ wantedLevelMax: 5, maxActivePatrols: 12, episodeMaxSeconds: 45 }),
    }, false);
    world.pursuit.cityChase = true;
    world.pursuit.gta.scanner = new PursuitScanner();
    world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);
    world.pursuit.frozenDriver = {
      policy,
      sha256,
      status: "active",
      lastTick: -1,
      decisions: 0,
      recoverStale: true,
      evasion: false,
      evasiveControl: PAKO_EVASIVE_CONTROL,
    };

    let maxWaitS = 0;
    let losBreakSteps = 0;
    for (let t = 0; t < 900 && world.pursuit?.phase === "running"; t++) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
      world.step();
      if (world.pursuit?.phase === "running") {
        maxWaitS = Math.max(maxWaitS, world.player.wait ?? 0);
        if (world.pursuit.frozenDriver?.lastDecision?.planner?.tacticalTag === "los-break") {
          losBreakSteps++;
        }
      }
    }

    const endedPhase = world.pursuit?.phase ?? "unknown";
    const pedHits = world.pursuit?.metrics?.pedestrianCollisions ?? 0;
    const distM = Number((world.pursuit?.metrics?.distanceM ?? world.metrics.distance).toFixed(1));
    const stuck = (endedPhase === "running" && (world.player.wait ?? 0) > 6.5) || maxWaitS > 6.5 || distM < 25;
    if (stuck) stuckRuns++;
    totalPedestrianHits += pedHits;
    runs.push({
      seed,
      phase: endedPhase,
      distanceM: distM,
      pedestrianHits: pedHits,
      maxWaitS: Number(maxWaitS.toFixed(2)),
      losBreakSteps,
      stuck,
    });
  }

  return {
    runs,
    stuckRuns,
    totalPedestrianHits,
  };
}

if (negativeFaultMode) {
  const legacySlow = runStraightCatchupTrial({ tactical: false });
  const legacyEndlessZone = runOpenRoadStarDecayTrial({ tactical: false });
  const closeRangeGuard = runCloseRangeNoDecayCheck();

  const payload = {
    passed: false,
    detectedLegacySlowPatrol: legacySlow.passed === false,
    detectedOmniscientEndlessTracking: legacyEndlessZone.passed === false && legacyEndlessZone.observedZoneTrackedTrap === true,
    detectedCloseRangeNoDecayGuard: closeRangeGuard.starsStayedAt3 === true,
    details: {
      legacySlow,
      legacyEndlessZone,
      closeRangeGuard,
    },
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(payload, null, 2));
  console.log("Negative control faults verified:", JSON.stringify(payload, null, 2));
  const allCaught =
    payload.detectedLegacySlowPatrol &&
    payload.detectedOmniscientEndlessTracking &&
    payload.detectedCloseRangeNoDecayGuard;
  process.exit(allCaught ? 1 : 0);
}

const { policy, sha256 } = loadBundledCheckpoint();
const straightCatchupTrial = runStraightCatchupTrial({ tactical: true });
const offRoadPursuitTrial = runOffRoadPursuitTrial();
const laneOvertakeTrial = runLaneOvertakeTrial();
const openRoadStarDecayTrial = runOpenRoadStarDecayTrial({ tactical: true });
const alleyHideStarDecayTrial = runAlleyHideStarDecayTrial();
const reacquireMidDecayTrial = runReacquireMidDecayTrial();
const rlTacticalSweep = runRlTacticalSweep(policy, sha256);

const pedestrianHits =
  offRoadPursuitTrial.pedestrianHits + rlTacticalSweep.totalPedestrianHits;

const passed =
  straightCatchupTrial.passed &&
  offRoadPursuitTrial.passed &&
  laneOvertakeTrial.passed &&
  openRoadStarDecayTrial.passed &&
  alleyHideStarDecayTrial.passed &&
  reacquireMidDecayTrial.passed &&
  pedestrianHits === 0 &&
  rlTacticalSweep.stuckRuns === 0;

const evalPayload = {
  passed,
  checkpointSha256: sha256,
  straightCatchupTrial,
  offRoadPursuitTrial,
  laneOvertakeTrial,
  openRoadStarDecayTrial,
  alleyHideStarDecayTrial,
  reacquireMidDecayTrial,
  rlTacticalSweep,
  pedestrianHits,
};

writeFileSync(join(outDir, "tactical-police-eval.json"), JSON.stringify(evalPayload, null, 2));
console.log("Tactical police & GTA escape evaluation:", JSON.stringify(evalPayload, null, 2));
if (!passed) process.exit(1);
