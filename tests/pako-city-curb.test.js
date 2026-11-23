import assert from "node:assert/strict";
import test from "node:test";
import { Raycaster, Vector3 } from "three";
import { STEP } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, corners, distance, overlaps, roadRect } from "../src/core/geometry.js";
import {
  METRO_CITY_CURBS,
  METRO_CURB_SUPPORT,
  acceptCurbPose,
  curbClearance,
  curbCommand,
  isPoseSupportedWithCurbs,
  nearCurb,
  surveyMetroCurb,
  sweepSafeWithCurbs,
} from "../src/core/pako-curb.js";
import { integrateGtaSlip } from "../src/core/pursuit-gta.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { PLAYER_VEHICLE, mountToWorld } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";

const SEED = "pako-city-curb-dev";
const makeCity = (traffic = 0, pedestrians = 0) =>
  new World({ cityVersion: 4, seed: SEED, traffic, pedestrians }, "metro");
const solid = (id, x, z, width, length, height = 1.8, heading = 0) =>
  Object.freeze({ id, type: "static", kind: "barrier", x, z, width, length, height, heading });

function startCityCurbPursuit(world, extra = {}) {
  const network = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(network);
  const base = { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false, ...extra };
  try {
    world.command({ type: "street-pursuit-start", variant: "gta", config: { ...base, curbSupport: METRO_CITY_CURBS } });
  } catch {
    world.command({ type: "street-pursuit-start", variant: "gta", config: { ...base, curbSupport: METRO_CURB_SUPPORT } });
    world.pursuit.gta.curb = network;
  }
  return network;
}

const smooth = value => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, value)))) / 2;
const civicTargetX = (z, offset = 4.42) =>
  -180.5 + offset * (smooth((z + 66) / 26) - smooth((z + 22) / 26));

function civicAction(player, { targetSpeed = 5.0, throttle, offset = 4.42 } = {}) {
  const aheadZ = player.z + Math.max(1.2, player.speed * .35);
  const x = civicTargetX(aheadZ, offset);
  const slope = (civicTargetX(aheadZ + .2, offset) - x) / .2;
  const heading = Math.atan((x - player.x) * .38 + slope);
  return {
    steer: Math.max(-.75, Math.min(.75, angleDelta(heading, player.heading) * 2.1)),
    throttle: throttle ?? (player.speed < targetSpeed ? .85 : 0),
    brake: 0,
    gear: 1,
  };
}

const drive = (world, action) => {
  world.command({ type: "pursuit-drive", action }, false);
  world.step();
};

const projectGta = (actor, command) => {
  const next = integrateVehicle(actor, command, STEP);
  integrateGtaSlip(actor, next);
  return next;
};

function staticBounds(site) {
  const c = Math.abs(Math.cos(site.heading ?? 0)), s = Math.abs(Math.sin(site.heading ?? 0));
  const x = ((site.width ?? 0) * c + (site.length ?? 0) * s) / 2;
  const z = ((site.width ?? 0) * s + (site.length ?? 0) * c) / 2;
  return { minX: site.x - x, maxX: site.x + x, minZ: site.z - z, maxZ: site.z + z };
}

test("surveyMetroCurb(world, METRO_CITY_CURBS) surveys x/z avenues and streets on both sides while excluding junctions and buildings", () => {
  const world = makeCity(0, 0);
  const v1Default = surveyMetroCurb(world);
  const v1Explicit = surveyMetroCurb(world, METRO_CURB_SUPPORT);
  assert.deepEqual(v1Default, v1Explicit);
  assert.equal(v1Default.id, "tahrir-positive-midblock");
  assert.equal(surveyMetroCurb(world, "unknown-mode"), null);
  assert.equal(surveyMetroCurb({ environment: "city", config: { cityVersion: 4 }, roads: world.roads }, METRO_CITY_CURBS), null);
  assert.equal(surveyMetroCurb({ environment: "metro", config: { cityVersion: 3 }, roads: world.roads }, METRO_CITY_CURBS), null);

  const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(curb && Object.isFrozen(curb) && Object.isFrozen(curb.sites) && Object.isFrozen(curb.courtyards));
  assert.equal(curb.mode, METRO_CITY_CURBS);
  assert.equal(curb.maxPace, 14.0);
  assert.equal(curb.maxYawRate, 3.6);
  assert.ok(curb.sites.length >= 50, `expected >= 50 sites, got ${curb.sites.length}`);
  assert.deepEqual(
    curb.courtyards.map(c => ({ id: c.id, minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ })),
    [
      { id: "metro-avenue-blocks", minX: -278, maxX: -96, minZ: -112, maxZ: 90 },
      { id: "metro-feeder-blocks", minX: -96, maxX: -32, minZ: -112, maxZ: 38 },
      { id: "metro-district-blocks", minX: -46, maxX: 54, minZ: -42, maxZ: 38 },
    ],
  );
  for (const c of curb.courtyards) assert.ok(Object.isFrozen(c));

  for (const roadId of [
    "tahrir-boulevard", "station-avenue", "souq-collector", "university-avenue",
    "corniche-avenue", "civic-avenue", "gateway-avenue", "bab-el-louk-link",
  ]) {
    for (const side of [-1, 1]) {
      assert.ok(
        curb.sites.some(s => s.roadId === roadId && s.side === side),
        `missing curb site for ${roadId} side=${side}`,
      );
    }
  }
  assert.ok(curb.sites.some(s => s.axis === "x" && s.avenue === true));
  assert.ok(curb.sites.some(s => s.axis === "z" && s.avenue === true));
  assert.ok(curb.sites.some(s => s.axis === "x" && s.avenue === false));
  assert.ok(curb.sites.some(s => s.axis === "z" && s.avenue === false));

  const roadById = new Map(world.roads.map(r => [r.id, r]));
  const nonBayRoads = world.roads.filter(r => !r.parkingBay);
  const statics = world.statics.map(staticBounds);

  for (const site of curb.sites) {
    assert.ok(Object.isFrozen(site));
    const road = roadById.get(site.roadId);
    assert.ok(road && !road.parkingBay && !road.supportApron);
    const spanLen = site.axis === "x" ? site.maxX - site.minX : site.maxZ - site.minZ;
    assert.ok(spanLen >= 9.0 - 1e-9, `${site.id} span too short: ${spanLen}`);

    const outwardLo = Math.min(site.edge, site.edge + site.side * 2.38);
    const outwardHi = Math.max(site.edge, site.edge + site.side * 2.38);
    const enterLo = Math.min(site.edge + .05 * site.side, site.edge + site.side * 2.38);
    const enterHi = Math.max(site.edge + .05 * site.side, site.edge + site.side * 2.38);
    for (const other of nonBayRoads) {
      if (other === road) continue;
      const r = roadRect(other);
      const crossMin = site.axis === "x" ? r.minZ : r.minX;
      const crossMax = site.axis === "x" ? r.maxZ : r.maxX;
      if (!(crossMin <= enterHi && crossMax >= enterLo)) continue;
      const fullSidewalkCover = crossMin <= outwardLo + 1e-6 && crossMax >= outwardHi - 1e-6;
      const [rLo, rHi] = site.axis === "x" ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
      const alongSeparated = fullSidewalkCover && rHi - rLo > .4
        ? (site.axis === "x"
          ? site.maxX <= rLo + .12 + 1e-9 || site.minX >= rHi - .12 - 1e-9
          : site.maxZ <= rLo + .12 + 1e-9 || site.minZ >= rHi - .12 - 1e-9)
        : (site.axis === "x"
          ? site.maxX <= rLo - .30 + 1e-9 || site.minX >= rHi + .30 - 1e-9
          : site.maxZ <= rLo - .30 + 1e-9 || site.minZ >= rHi + .30 - 1e-9);
      assert.ok(alongSeparated, `${site.id} overlaps cross-road ${other.id}`);
    }
    for (const b of statics) {
      const crossOverlaps = site.axis === "x"
        ? b.minZ <= outwardHi && b.maxZ >= outwardLo
        : b.minX <= outwardHi && b.maxX >= outwardLo;
      if (!crossOverlaps) continue;
      const alongSeparated = site.axis === "x"
        ? site.maxX <= b.minX - .30 + 1e-9 || site.minX >= b.maxX + .30 - 1e-9
        : site.maxZ <= b.minZ - .30 + 1e-9 || site.minZ >= b.maxZ + .30 - 1e-9;
      assert.ok(alongSeparated, `${site.id} overlaps static obstacle`);
    }
  }

  // Injecting a static kiosk on civic-avenue's +x sidewalk cuts that span cleanly by 0.30 m margin.
  const withKiosk = makeCity(0, 0);
  const kiosk = solid("dev-civic-kiosk", -175.8, -35, 1.6, 4.0, 2.6, 0);
  withKiosk.statics.push(kiosk);
  const cutCurb = surveyMetroCurb(withKiosk, METRO_CITY_CURBS);
  const civicPosSpans = cutCurb.sites.filter(s => s.roadId === "civic-avenue" && s.side === 1);
  assert.ok(civicPosSpans.every(s => s.maxZ <= -37.3 + 1e-9 || s.minZ >= -32.7 - 1e-9));
});

test("SUV climbs and traverses z-axis civic-avenue curb at ~5.0 m/s, bypasses barrier, and returns to asphalt", t => {
  const world = makeCity(0, 0);
  const off = makeCity(0, 0);
  const startPose = { x: -180.5, z: -67, heading: 0, speed: 0 };
  Object.assign(world.player, startPose);
  Object.assign(off.player, startPose);

  // Full carriageway barrier terminating 0.35 m short of civic-avenue's +x edge (-177).
  const wall = solid("dev-civic-shutter", -183.175, -31, 11.65, 1.0, 1.6, 0);
  world.statics.push(wall);
  off.statics.push(solid("dev-civic-shutter", -183.175, -31, 11.65, 1.0, 1.6, 0));

  const view = new WorldView(world);
  t.after(() => view.dispose());

  const curb = startCityCurbPursuit(world);
  off.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false },
  });

  // Verify trajectory planner helpers across the barrier bypass vs blocked road.
  const roadBlockedSweep = sweepSafeWithCurbs(
    { ...world.player, x: -180.5, z: -35, heading: 0 },
    { ...world.player, x: -180.5, z: -27, heading: 0 },
    world.statics, world.roads, curb,
  );
  assert.deepEqual(roadBlockedSweep, { safe: false, reason: "occupied", actor: wall.id });

  const curbBypassSweep = sweepSafeWithCurbs(
    { ...world.player, x: -176.08, z: -38, heading: 0 },
    { ...world.player, x: -176.08, z: -24, heading: 0 },
    world.statics, world.roads, curb,
  );
  assert.deepEqual(curbBypassSweep, { safe: true, reason: "clear" });

  let entryTick = null, bypassTick = null, exitTick = null, offBoundaryTick = null;
  let maxCurbPace = 0, maxClimb = 0, minDip = 0, maxWheelSpan = 0, wheelSurvey = null;

  for (let i = 0; i < 1200 && world.player.z < 8; i++) {
    const p = world.player;
    const action = civicAction(p, { targetSpeed: 5.0 });
    drive(world, action);
    drive(off, civicAction(off.player, { targetSpeed: 5.0 }));

    assert.equal(overlaps(p, wall), false);
    assert.equal(bodyOnRoad(off.player, off.roads), true);
    if (off.player.reason === "road-boundary") offBoundaryTick ??= off.tick;

    const y = p.y ?? 0;
    maxClimb = Math.max(maxClimb, y);
    minDip = Math.min(minDip, y);

    if (p.curbSupportId) {
      assert.equal(p.curbSupportId, "civic-avenue:pos:1");
      assert.equal(bodyOnRoad(p, world.roads), false);
      assert.equal(isPoseSupportedWithCurbs(curb, world.roads, p), true);
      const pace = Math.hypot(p.speed, p.gtaSlipMps ?? 0);
      assert.ok(pace <= 14.0 + 1e-8);
      maxCurbPace = Math.max(maxCurbPace, pace);

      const offsets = Object.values(p.vehicle.suspension.wheelOffsetsM);
      assert.ok(offsets.every(v => Math.abs(v) <= PLAYER_VEHICLE.suspensionTravelM + 1e-9));
      maxWheelSpan = Math.max(maxWheelSpan, Math.max(...offsets) - Math.min(...offsets));

      entryTick ??= world.tick;
      if (Math.abs(p.z - wall.z) < .12) bypassTick ??= world.tick;
      assert.ok(Math.abs(mountToWorld(p, { x: 0, y: 1, z: 0 }).y - (1.12 + y)) < 1e-12);

      if (!wheelSurvey && y >= .01) {
        const root = view.syncMetroPlayer(1);
        assert.equal(root.position.y, .12 + p.y);
        const surfaces = [
          ...view.surfaces.road,
          ...view.surfaces.pavement,
          view.egyptStreets.root.getObjectByName("egypt-painted-curb"),
        ];
        wheelSurvey = ["front-left", "front-right", "rear-left", "rear-right"].map(name => {
          const pivot = root.getObjectByName(`wheel-${name}`).getWorldPosition(new Vector3());
          const ray = new Raycaster(new Vector3(pivot.x, 2, pivot.z), new Vector3(0, -1, 0));
          const surface = ray.intersectObjects(surfaces, false)[0].point.y;
          const tire = pivot.y - .35;
          assert.ok(Math.abs(tire - surface) < .008, `${name} tire ${tire} vs rendered surface ${surface}`);
          return { name, tire, surface };
        });
        assert.ok(wheelSurvey.some(w => w.surface > .15));
      }
    } else if (entryTick) {
      exitTick ??= world.tick;
    }
  }

  assert.ok(entryTick && bypassTick && exitTick && entryTick < bypassTick && bypassTick < exitTick);
  assert.ok(maxCurbPace > 4.7 && maxCurbPace <= 14.0 + 1e-8, `expected ~5.0 m/s curb pace, got ${maxCurbPace}`);
  assert.ok(maxClimb >= .01 && minDip < -.02 && maxWheelSpan > .025 && wheelSurvey);
  assert.ok(world.player.z >= 8 && bodyOnRoad(world.player, world.roads));
  assert.equal(world.player.y, 0);
  assert.equal(world.player.supportHeightM, 0);
  assert.equal(world.player.curbSupportId, null);
  assert.equal(world.pursuit.metrics.shoulderEntries, 1);
  assert.equal(world.pursuit.metrics.shoulderExits, 1);
  assert.equal(world.pursuit.metrics.collisions, 0);

  assert.ok(offBoundaryTick && offBoundaryTick <= entryTick + 5);
  assert.ok(off.player.z < wall.z - 4);
  assert.equal(off.pursuit.metrics.shoulderEntries, 0);

  // Also check gentle flush curb profile on a non-avenue neighborhood street (souq-collector, avenue: false).
  const souqSite = curb.sites.find(s => s.roadId === "souq-collector" && s.side === 1);
  assert.ok(souqSite && souqSite.avenue === false);
  const streetPose = {
    x: (souqSite.minX + souqSite.maxX) / 2,
    z: souqSite.edge - PLAYER_VEHICLE.trackM / 2 + .18,
    heading: Math.PI / 2,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
  };
  const streetOffsets = acceptCurbPose(curb, world.roads, streetPose);
  assert.ok(streetOffsets);
  assert.equal(streetPose.curbSupportId, souqSite.id);
  // Left wheels sit at out = 0.18 m on the 0.125 m flush lip (+0.01 m above 0.115 asphalt), right wheels on asphalt (0).
  assert.ok(Math.abs(streetPose.y - .005) < 1e-9);
  assert.ok(Object.values(streetOffsets).every(v => Math.abs(v) <= PLAYER_VEHICLE.suspensionTravelM));
});

test("negative controls: sidewalk pedestrian, tall barrier, outer perimeter edge, and speed > 14.0 m/s are safely rejected or capped while post-impact spin <= 3.6 rad/s is allowed", () => {
  // 1. Pedestrian standing on civic-avenue sidewalk triggers curb-pedestrian rejection; resumes once clear.
  {
    const world = makeCity(0, 1);
    Object.assign(world.player, { x: -180.5, z: -67, heading: 0, speed: 0 });
    const wall = solid("dev-civic-shutter", -183.175, -31, 11.65, 1.0, 1.6, 0);
    world.statics.push(wall);
    const person = world.actors.find(a => a.type === "pedestrian");
    Object.assign(person, { x: -175.8, z: -32, heading: 0, speed: 0 });
    world.command({ type: "pedestrian-motion", mode: "stop", id: person.id });
    startCityCurbPursuit(world);

    let pedReject = null;
    for (let i = 0; i < 600; i++) {
      drive(world, civicAction(world.player, { targetSpeed: 5.0 }));
      assert.equal(overlaps(world.player, person), false);
      if (world.player.reason === "curb-pedestrian")
        pedReject ??= [world.tick, world.player.z, world.player.blockedBy];
    }
    assert.ok(pedReject, "expected curb-pedestrian rejection");
    assert.equal(pedReject[2], person.id);
    assert.ok(world.player.z < person.z - 2);
    assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
    assert.equal(world.pursuit.metrics.collisions, 0);

    // Move pedestrian clear and verify SUV resumes past the barrier onto asphalt.
    Object.assign(person, { x: -195, z: -32, speed: 0 });
    for (let i = 0; i < 700 && world.player.z < 6; i++) {
      drive(world, civicAction(world.player, { targetSpeed: 5.0 }));
    }
    assert.ok(world.player.z >= 6 && bodyOnRoad(world.player, world.roads));
    assert.equal(world.player.curbSupportId, null);
    assert.equal(world.pursuit.metrics.collisions, 0);
  }

  // 2. Tall static barrier / building block on the sidewalk triggers curb-solid rejection.
  {
    const world = makeCity(0, 0);
    Object.assign(world.player, { x: -180.5, z: -67, heading: 0, speed: 0 });
    world.statics.push(solid("dev-civic-shutter", -183.175, -31, 11.65, 1.0, 1.6, 0));
    const pillar = solid("dev-sidewalk-pillar", -175.7, -33, 2.4, .7, 2.4, 0);
    world.statics.push(pillar);
    // Start pursuit with stock sidewalk survey (as if a runtime roadblock/solid occupies the sidewalk).
    const cleanWorld = makeCity(0, 0);
    const curb = surveyMetroCurb(cleanWorld, METRO_CITY_CURBS);
    startCityCurbPursuit(world);
    world.pursuit.gta.curb = curb;

    let solidReject = null;
    for (let i = 0; i < 600; i++) {
      drive(world, civicAction(world.player, { targetSpeed: 5.0 }));
      assert.equal(overlaps(world.player, pillar), false);
      if (world.player.reason === "curb-solid")
        solidReject ??= [world.tick, world.player.z, world.player.blockedBy];
    }
    assert.ok(solidReject, "expected curb-solid rejection");
    assert.equal(solidReject[2], pillar.id);
    assert.ok(world.player.z < pillar.z - 2);
    assert.equal(world.pursuit.metrics.collisions, 0);
  }

  // 3. Steering past outer perimeter sidewalk edge OR cutting off-road outside outer ring triggers road-boundary.
  {
    const world = makeCity(0, 0);
    Object.assign(world.player, { x: -280.5, z: -67, heading: 0, speed: 0 });
    const curb = startCityCurbPursuit(world);

    // Off-road cut outside the outer ring north of school-local & east of gateway-avenue (x = -88.2, z = 45).
    const outerCornerPose = {
      x: -88.2, z: 45, heading: 0,
      width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM,
    };
    assert.equal(isPoseSupportedWithCurbs(curb, world.roads, outerCornerPose), false);
    assert.deepEqual(
      sweepSafeWithCurbs({ ...outerCornerPose, x: -93 }, outerCornerPose, world.statics, world.roads, curb),
      { safe: false, reason: "road-boundary" },
    );

    let boundaryReject = null;
    for (let i = 0; i < 450; i++) {
      const p = world.player;
      const aheadZ = p.z + Math.max(1.2, p.speed * .35);
      const targetX = -280.5 - 8.2 * smooth((aheadZ + 66) / 26);
      const heading = Math.atan((targetX - p.x) * .38);
      drive(world, {
        steer: Math.max(-.75, Math.min(.75, angleDelta(heading, p.heading) * 2.1)),
        throttle: p.speed < 4.5 ? .85 : 0,
        brake: 0,
        gear: 1,
      });
      if (p.reason === "road-boundary") {
        boundaryReject ??= [world.tick, p.x, p.z];
      }
      assert.ok(Math.min(...corners(p).map(c => c.x)) >= -287.38 - 1e-6);
    }
    assert.ok(boundaryReject, "expected road-boundary when steering beyond 2.38 m outer Corniche sidewalk");
  }

  // 4. Full-throttle approach > 14.0 m/s triggers curb-approach-speed / curb-speed-limit, post-impact spin <= 3.6 rad/s is allowed, and > 3.6 rad/s fails closed with curb-speed.
  {
    const world = makeCity(0, 0);
    Object.assign(world.player, { x: -178.4, z: -66, heading: .08, speed: 15.8 });
    const curb = startCityCurbPursuit(world, { chasePresence: "city-chase-v1" });
    assert.equal(nearCurb(curb, world.player), true);

    let sawApproachBrake = false, sawSpeedCap = false, peakCurbPace = 0;
    for (let i = 0; i < 320 && world.player.z < -5; i++) {
      const p = world.player;
      const desiredHeading = Math.atan((-176.15 - p.x) * .28);
      const steer = Math.max(-.5, Math.min(.5, angleDelta(desiredHeading, p.heading) * 1.8));
      drive(world, { steer, throttle: 1, brake: 0, gear: 1 });
      if (p.reason === "curb-approach-speed") sawApproachBrake = true;
      if (p.reason === "curb-speed-limit") sawSpeedCap = true;
      if (p.curbSupportId) {
        const pace = Math.hypot(p.speed, p.gtaSlipMps ?? 0);
        peakCurbPace = Math.max(peakCurbPace, pace);
        assert.ok(pace <= 14.0 + 1e-8);
      }
    }
    assert.ok(sawApproachBrake, "expected curb-approach-speed braking from 15.8 m/s");
    assert.ok(sawSpeedCap && peakCurbPace > 13.2 && peakCurbPace <= 14.0 + 1e-8, `peakCurbPace=${peakCurbPace}`);

    // Direct curbCommand & curbClearance overspeed and yaw-rate checks.
    const fastActor = {
      ...world.player,
      x: -176.0, z: -45, heading: 0, speed: 14.6, gtaSlipMps: 0, gtaYawRate: 0,
      curbSupportId: "civic-avenue:pos:1",
    };
    const rawCmd = { steer: 0, targetSpeed: 18 };
    const cappedCmd = curbCommand(curb, world.roads, fastActor, rawCmd, projectGta(fastActor, rawCmd), projectGta);
    assert.equal(cappedCmd.targetSpeed, 14.0);
    assert.equal(cappedCmd.reason, "curb-speed-limit");

    const fastNext = projectGta(fastActor, cappedCmd);
    assert.deepEqual(
      curbClearance(world, curb, { a: fastActor, next: fastNext, command: cappedCmd, travel: distance(fastActor, fastNext) }, [], projectGta),
      { reason: "curb-speed" },
    );

    // Post-impact police bump yaw spin up to 3.5 rad/s (<= 3.6) must NOT falsely trigger curb-speed!
    const bumpedActor = { ...fastActor, speed: 9.0, gtaYawRate: 3.45 };
    const bumpedNext = projectGta(bumpedActor, { steer: 0, targetSpeed: 9.0 });
    assert.equal(
      curbClearance(world, curb, { a: bumpedActor, next: bumpedNext, command: { steer: 0, targetSpeed: 9.0 }, travel: distance(bumpedActor, bumpedNext) }, [], projectGta),
      null,
    );

    const spinningActor = { ...fastActor, speed: 9.0, gtaYawRate: 3.75 };
    const spinNext = projectGta(spinningActor, { steer: 0, targetSpeed: 9.0 });
    assert.deepEqual(
      curbClearance(world, curb, { a: spinningActor, next: spinNext, command: { steer: 0, targetSpeed: 9.0 }, travel: distance(spinningActor, spinNext) }, [], projectGta),
      { reason: "curb-speed" },
    );

    // In v2 (METRO_CITY_CURBS), non-pedestrian vehicles/patrols do NOT freeze ego with curb-solid;
    // v1 (METRO_CURB_SUPPORT) preserves its exact legacy vehicle-mover curb-solid rejection.
    const legalActor = { ...fastActor, speed: 9.5, gtaYawRate: 0 };
    const legalCmd = { steer: 0, targetSpeed: 9.5 };
    const legalNext = projectGta(legalActor, legalCmd);
    const mover = {
      id: "traffic-van-1", type: "vehicle",
      x: -176.2, z: -39.5, heading: Math.PI, speed: 2.0,
      width: 1.9, length: 4.4,
    };
    const moverNext = { ...mover, z: mover.z - 2.0 * STEP };
    assert.equal(
      curbClearance(
        world, curb,
        { a: legalActor, next: legalNext, command: legalCmd, travel: distance(legalActor, legalNext) },
        [{ a: mover, next: moverNext, radius: Math.hypot(mover.width, mover.length) / 2, travel: 2.0 * STEP }],
        projectGta,
      ),
      null,
    );

    const v1Curb = surveyMetroCurb(world, METRO_CURB_SUPPORT);
    const v1Actor = {
      ...world.player,
      x: -230, z: -104.2, heading: Math.PI / 2, speed: 2.2, gtaSlipMps: 0, gtaYawRate: 0,
      curbSupportId: v1Curb.id,
    };
    const v1Cmd = { steer: 0, targetSpeed: 2.2 };
    const v1Next = projectGta(v1Actor, v1Cmd);
    const v1Mover = {
      id: "v1-van", type: "vehicle",
      x: -226.4, z: -104.2, heading: -Math.PI / 2, speed: 1.5,
      width: 1.9, length: 4.4,
    };
    const v1MoverNext = { ...v1Mover, x: v1Mover.x - 1.5 * STEP };
    assert.deepEqual(
      curbClearance(
        world, v1Curb,
        { a: v1Actor, next: v1Next, command: v1Cmd, travel: distance(v1Actor, v1Next) },
        [{ a: v1Mover, next: v1MoverNext, radius: Math.hypot(v1Mover.width, v1Mover.length) / 2, travel: 1.5 * STEP }],
        projectGta,
      ),
      { reason: "curb-solid", blockedBy: v1Mover.id },
    );
  }
});

test("sidewalk-to-cross-street intersections have zero 0.30 m dead-zone gap at 5 cm steps and T-junction opposite sidewalks stay continuous", () => {
  const world = makeCity(0, 0);
  const curb = startCityCurbPursuit(world);

  // 1. T-junction opposite-side continuous sidewalks are NOT split by roads terminating on the opposite edge.
  // station-avenue (z = -75, max = -96) and souq-collector (z = 8, max = -96) terminate on gateway-avenue's -1 (west) side;
  // gateway-avenue's +1 (east) sidewalk runs continuously from Tahrir (-105.12) to school-local (35.02).
  const gatewayEast = curb.sites.filter(s => s.roadId === "gateway-avenue" && s.side === 1);
  assert.ok(gatewayEast[0].minZ <= -105.1 && gatewayEast[0].maxZ >= 35.0,
    `expected continuous gateway-avenue east sidewalk across z=-75 and z=8, got [${gatewayEast[0].minZ}, ${gatewayEast[0].maxZ}]`);
  for (const z of [-75, 8]) {
    const oppositeSidewalkPose = {
      x: -88.6, z, heading: 0,
      width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM,
    };
    assert.equal(bodyOnRoad(oppositeSidewalkPose, world.roads), false);
    assert.equal(isPoseSupportedWithCurbs(curb, world.roads, oppositeSidewalkPose), true,
      `expected continuous support opposite T-junction at z=${z}`);
  }

  // corniche-avenue (-1 west) and tahrir-boulevard (-1 south) opposite T-junctions are single continuous spans.
  const cornicheWest = curb.sites.filter(s => s.roadId === "corniche-avenue" && s.side === -1);
  assert.equal(cornicheWest.length, 1);
  assert.ok(cornicheWest[0].minZ <= -110.7 && cornicheWest[0].maxZ >= 88.7);
  const tahrirSouth = curb.sites.filter(s => s.roadId === "tahrir-boulevard" && s.side === -1);
  assert.equal(tahrirSouth.length, 1);
  assert.ok(tahrirSouth[0].minX <= -276.7 && tahrirSouth[0].maxX >= -33.3);

  // 2. Every 5 cm step off the end of a sidewalk span into a perpendicular cross-street is supported (zero dead-zone gap),
  // even when riding near the outer 2.38 m sidewalk edge.
  const transitions = [
    // civic-avenue:pos:0 north into station-avenue (z = -81..-69), then onto civic-avenue:pos:1
    { axis: "z", lat: -177 + 1.43, from: -86, to: -64, heading: 0 },
    // civic-avenue:pos:1 north into souq-collector (z = 3..13), then onto civic-avenue:pos:2
    { axis: "z", lat: -177 + 1.43, from: -2, to: 18, heading: 0 },
    // tahrir-boulevard:pos:0 east into civic-avenue (x = -189..-177), where road widths differ (14 m vs 12 m)
    { axis: "x", lat: -105 + 1.43, from: -194, to: -172, heading: Math.PI / 2 },
    // station-avenue:pos:1 east into gateway-avenue T-junction (x = -102..-90)
    { axis: "x", lat: -69 + 1.43, from: -107, to: -93, heading: Math.PI / 2 },
  ];
  for (const { axis, lat, from, to, heading } of transitions) {
    const steps = Math.round((to - from) / 0.05);
    for (let i = 0; i <= steps; i++) {
      const along = from + i * 0.05;
      const pose = {
        x: axis === "x" ? along : lat,
        z: axis === "x" ? lat : along,
        heading,
        width: PLAYER_VEHICLE.widthM,
        length: PLAYER_VEHICLE.lengthM,
      };
      assert.equal(
        isPoseSupportedWithCurbs(curb, world.roads, pose),
        true,
        `unsupported dead-zone at ${axis}=${along.toFixed(2)}, lat=${lat.toFixed(2)}`,
      );
    }
  }

  // 3. Live World step traversal straight off civic-avenue:pos:0 across station-avenue onto civic-avenue:pos:1.
  Object.assign(world.player, {
    x: -175.65, z: -87.5, heading: 0, speed: 4.5,
    curbSupportId: "civic-avenue:pos:0",
  });
  acceptCurbPose(curb, world.roads, world.player);
  let crossedRoadway = false, enteredNextSpan = false;
  for (let i = 0; i < 360 && world.player.z < -63; i++) {
    drive(world, { steer: 0, throttle: .7, brake: 0, gear: 1 });
    assert.notEqual(world.player.reason, "road-boundary");
    assert.ok(world.player.speed > 3.5, `expected smooth cross-street exit, got speed=${world.player.speed}`);
    if (!world.player.curbSupportId && bodyOnRoad(world.player, world.roads)) crossedRoadway = true;
    if (world.player.curbSupportId === "civic-avenue:pos:1") enteredNextSpan = true;
  }
  assert.ok(crossedRoadway && enteredNextSpan, "expected SUV to cross station-avenue asphalt and enter next sidewalk span");
});

test("police cruiser 0.05 m from SUV on METRO_CITY_CURBS does not freeze with curb-solid while sidewalk pedestrians still trigger curb-pedestrian", () => {
  const world = makeCity(0, 1);
  const curb = startCityCurbPursuit(world);

  // Place SUV at 0 km/h on civic-avenue:pos:0 right before station-avenue crosswalk.
  const egoActor = {
    ...world.player,
    x: -176.0, z: -82.8, heading: 0, speed: 0, steer: 0,
    gtaSlipMps: 0, gtaYawRate: 0,
    curbSupportId: "civic-avenue:pos:0",
  };
  const cmd = { steer: -.12, targetSpeed: 6.0 };
  const egoNext = projectGta(egoActor, cmd);
  const egoPlan = {
    a: egoActor,
    next: egoNext,
    command: cmd,
    travel: distance(egoActor, egoNext),
    radius: Math.hypot(egoActor.width, egoActor.length) / 2,
  };

  // Active police cruiser 0.05 m behind SUV's rear-left corner and another 0.05 m off SUV's left side.
  const rearPolice = {
    id: "street-pursuit-1-patrol-1",
    type: "vehicle",
    pursuitRole: "police",
    x: -176.45,
    z: egoActor.z - egoActor.length / 2 - 4.4 / 2 - .05,
    heading: 0,
    speed: 1.5,
    width: 1.9,
    length: 4.4,
  };
  const sidePolice = {
    id: "street-pursuit-1-patrol-2",
    type: "vehicle",
    pursuitRole: "police",
    x: egoActor.x - egoActor.width / 2 - 1.9 / 2 - .05,
    z: egoActor.z + 1.2,
    heading: 0,
    speed: 2.0,
    width: 1.9,
    length: 4.4,
  };
  const policePlans = [rearPolice, sidePolice].map(car => {
    const next = { ...car, z: car.z + car.speed * STEP };
    return { a: car, next, radius: Math.hypot(car.width, car.length) / 2, travel: car.speed * STEP };
  });

  // Confirm cruisers are 0.05 m away (overlapping at 0.06 m, separated at 0.04 m) yet curbClearance returns null!
  assert.equal(overlaps(egoActor, rearPolice, .06), true);
  assert.equal(overlaps(egoActor, rearPolice, .04), false);
  assert.equal(overlaps(egoActor, sidePolice, .06), true);
  assert.equal(overlaps(egoActor, sidePolice, .04), false);
  assert.equal(curbClearance(world, curb, egoPlan, policePlans, projectGta), null);

  // Sidewalk pedestrian in front of SUV STILL strictly returns { reason: "curb-pedestrian" }!
  const movingEgo = { ...egoActor, speed: 3.5 };
  const movingNext = projectGta(movingEgo, { steer: 0, targetSpeed: 3.5 });
  const person = world.actors.find(a => a.type === "pedestrian");
  Object.assign(person, { x: -175.9, z: -79.2, heading: Math.PI, speed: 0 });
  const pedPlan = { a: person, next: { ...person }, radius: person.radius, travel: 0 };
  assert.deepEqual(
    curbClearance(
      world,
      curb,
      { a: movingEgo, next: movingNext, command: { steer: 0, targetSpeed: 3.5 }, travel: distance(movingEgo, movingNext) },
      [...policePlans, pedPlan],
      projectGta,
    ),
    { reason: "curb-pedestrian", blockedBy: person.id },
  );

  // If a pedestrian already walked within the 0.48 m buffer of a stopped SUV, backing strictly away (>= 0.05 m gap)
  // is allowed so ego isn't frozen forever, whereas moving closer is rejected with curb-pedestrian.
  const closePed = { ...person, x: egoActor.x, z: egoActor.z + egoActor.length / 2 + person.radius + .25, speed: 0 };
  assert.equal(overlaps(egoActor, closePed, .48), true);
  const closePedPlan = { a: closePed, next: { ...closePed }, radius: closePed.radius, travel: 0 };
  const revCmd = { steer: 0, targetSpeed: -2.0 };
  const revNext = projectGta(egoActor, revCmd);
  assert.equal(
    curbClearance(world, curb, { a: egoActor, next: revNext, command: revCmd, travel: distance(egoActor, revNext) }, [closePedPlan], projectGta),
    null,
  );
  const fwdCmd = { steer: 0, targetSpeed: 1.5 };
  const fwdNext = projectGta(egoActor, fwdCmd);
  assert.deepEqual(
    curbClearance(world, curb, { a: egoActor, next: fwdNext, command: fwdCmd, travel: distance(egoActor, fwdNext) }, [closePedPlan], projectGta),
    { reason: "curb-pedestrian", blockedBy: closePed.id },
  );

  // Also verify steering onto/along a curb at 8.0 m/s under full lock (where holding lock for 0.95 s would curve off-sidewalk)
  // is allowed when straightening has a clean supported braking path, while an unrecoverable dive still rejects.
  const angledEntry = {
    ...egoActor,
    x: -176.45, z: -55, heading: .05, speed: 8.0, steer: .05,
    curbSupportId: "civic-avenue:pos:1",
  };
  const lockCmd = { steer: .55, targetSpeed: 8.0 };
  const lockNext = projectGta(angledEntry, lockCmd);
  assert.equal(
    curbClearance(
      world, curb,
      { a: angledEntry, next: lockNext, command: lockCmd, travel: distance(angledEntry, lockNext) },
      policePlans,
      projectGta,
    ),
    null,
  );

  const unrecoverableDive = {
    ...egoActor,
    x: -286.35, z: -55, heading: -.72, speed: 11.2, steer: -.55,
    curbSupportId: "corniche-avenue:neg:0",
  };
  const diveNext = projectGta(unrecoverableDive, { steer: -.55, targetSpeed: 11.2 });
  assert.deepEqual(
    curbClearance(
      world, curb,
      { a: unrecoverableDive, next: diveNext, command: { steer: -.55, targetSpeed: 11.2 }, travel: distance(unrecoverableDive, diveNext) },
      [],
      projectGta,
    ),
    { reason: "road-boundary" },
  );

  // Live screenshot-repro unstick: SUV at 0 km/h on sidewalk before cross-street with active GTA patrol 0.05 m off rear-left corner.
  const liveWorld = makeCity(0, 0);
  const liveCurb = startCityCurbPursuit(liveWorld, { maxActivePatrols: 1 });
  const cruiser = [...liveWorld.pursuit.patrols][0];
  assert.ok(cruiser, "expected active GTA patrol");
  Object.assign(liveWorld.player, {
    x: -176.0, z: -82.8, heading: -.06, speed: 0, steer: 0,
    gtaSlipMps: 0, gtaYawRate: 0,
    curbSupportId: "civic-avenue:pos:0",
  });
  acceptCurbPose(liveCurb, liveWorld.roads, liveWorld.player);
  Object.assign(cruiser, {
    x: -176.55,
    z: liveWorld.player.z - liveWorld.player.length / 2 - cruiser.length / 2 - .05,
    heading: 0,
    speed: 0,
    gtaSlipMps: 0,
    gtaYawRate: 0,
  });
  cruiser.previous = { ...cruiser };

  for (let i = 0; i < 150; i++) {
    drive(liveWorld, { steer: -.08, throttle: 1, brake: 0, gear: 1 });
    assert.notEqual(liveWorld.player.reason, "curb-solid");
    assert.notEqual(liveWorld.player.reason, "road-boundary");
  }
  assert.ok(liveWorld.player.z > -78.5 && liveWorld.player.speed > 4.0,
    `expected SUV to unstick and enter cross-street, got z=${liveWorld.player.z}, speed=${liveWorld.player.speed}`);
  assert.equal(liveWorld.player.curbSupportId, null);
  assert.equal(bodyOnRoad(liveWorld.player, liveWorld.roads), true);
});

test("SUV cuts through open between-buildings alley from tahrir-boulevard (z=-112) across courtyard (z=-93) onto station-avenue (z=-75) while preserving building/pedestrian clearance and outer map perimeter", t => {
  const world = makeCity(0, 1);
  const off = makeCity(0, 0);
  const curb = startCityCurbPursuit(world);
  off.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false },
  });

  // Verify the real Metro v4 building gap at x = -140.25 between tahrir-boulevard-frontage-1-3 and tahrir-boulevard-frontage-1-4.
  const westBldg = world.statics.find(s => s.id === "tahrir-boulevard-frontage-1-3");
  const eastBldg = world.statics.find(s => s.id === "tahrir-boulevard-frontage-1-4");
  assert.ok(westBldg?.kind === "building" && eastBldg?.kind === "building");
  const westBox = staticBounds(westBldg), eastBox = staticBounds(eastBldg);
  const alleyX = (westBox.maxX + eastBox.minX) / 2;
  assert.ok(eastBox.minX - westBox.maxX >= 9.0, `expected >= 9 m alley gap, got ${eastBox.minX - westBox.maxX}`);

  // 1. Outer world perimeter poses are strictly unsupported (SUV can never drive off the outer map edge).
  const outerPoses = [
    { x: -292, z: 0, heading: -Math.PI / 2 },     // west of Corniche outer sidewalk
    { x: -200, z: -126, heading: Math.PI },        // south of Tahrir outer sidewalk
    { x: -200, z: 102, heading: 0 },               // north of University outer sidewalk
    { x: 64, z: 0, heading: Math.PI / 2 },         // east of East Connector outer sidewalk
    { x: -60, z: 48, heading: 0 },                 // north of school-local & east of gateway-avenue
    { x: 0, z: -52, heading: Math.PI },            // south of entry-local & east of bab-el-louk-link
  ];
  for (const raw of outerPoses) {
    const pose = { ...raw, width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM };
    assert.equal(isPoseSupportedWithCurbs(curb, world.roads, pose), false,
      `expected outer perimeter pose (${raw.x}, ${raw.z}) to be unsupported`);
  }

  // 2. Step-by-step sweep across the open alley from tahrir-boulevard (z=-112) through courtyard (z=-93) onto station-avenue (z=-75).
  let prevSupportY = 0;
  let sawSouthLip = false, sawSouthSidewalk = false, sawSouthRamp = false;
  let sawCourtyard = false, sawNorthRamp = false, sawNorthLip = false;
  for (let z = -112; z <= -75 + 1e-9; z = Math.round((z + 0.08) * 100) / 100) {
    const pose = {
      x: alleyX, z, heading: 0,
      width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM,
    };
    assert.equal(isPoseSupportedWithCurbs(curb, world.roads, pose), true, `unsupported alley pose at z=${z}`);
    assert.equal(overlaps(pose, westBldg), false);
    assert.equal(overlaps(pose, eastBldg), false);
    const offsets = acceptCurbPose(curb, world.roads, pose);
    const y = pose.y ?? 0;
    assert.ok(Math.abs(y - prevSupportY) < 0.045, `abrupt chassis vertical jump at z=${z}: ${prevSupportY} -> ${y}`);
    prevSupportY = y;

    const wheelFrontZ = z + PLAYER_VEHICLE.wheelbaseM / 2;
    const wheelHeights = offsets ? Object.fromEntries(Object.entries(offsets).map(([k, v]) => [k, y + v])) : null;
    if (z === -112 || z === -75) {
      assert.equal(offsets, null);
      assert.equal(y, 0);
      assert.equal(pose.curbSupportId, null);
    } else if (Math.abs(z - -93) < 0.05) {
      sawCourtyard = true;
      assert.ok(Math.abs(y - (-0.165)) < 1e-9, `expected -0.165 courtyard height at z=${z}, got ${y}`);
      assert.ok(pose.curbSupportId && typeof pose.curbSupportId === "string");
      assert.ok(Object.values(offsets).every(v => Math.abs(v) < 1e-9));
      assert.equal(nearCurb(curb, { ...pose, speed: 6.0 }), true);
    }
    if (wheelHeights) {
      if (wheelFrontZ > -104.9 && wheelFrontZ < -104.73 && wheelHeights.frontLeft > 0.05) sawSouthLip = true;
      if (wheelFrontZ > -104.4 && wheelFrontZ < -102.7 && Math.abs(wheelHeights.frontLeft - (-0.045)) < 1e-6) sawSouthSidewalk = true;
      if (wheelFrontZ > -102.60 && wheelFrontZ < -102.48 && wheelHeights.frontLeft < -0.05 && wheelHeights.frontLeft > -0.16) sawSouthRamp = true;
      if (wheelFrontZ > -83.52 && wheelFrontZ < -83.40 && wheelHeights.frontLeft > -0.16 && wheelHeights.frontLeft < -0.05) sawNorthRamp = true;
      if (wheelFrontZ > -81.27 && wheelFrontZ < -81.10 && wheelHeights.frontLeft > 0.05) sawNorthLip = true;
    }
  }
  assert.ok(sawSouthLip && sawSouthSidewalk && sawSouthRamp && sawCourtyard && sawNorthRamp && sawNorthLip,
    `missing 3-layer wheel transition stage: ${JSON.stringify({ sawSouthLip, sawSouthSidewalk, sawSouthRamp, sawCourtyard, sawNorthRamp, sawNorthLip })}`);

  // Deep interior courtyard > 12 m from any road site uses "metro-courtyard" support id and keeps nearCurb active.
  const deepCourtPose = {
    x: -140, z: -33, heading: 0, speed: 5.0,
    width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM,
  };
  acceptCurbPose(curb, world.roads, deepCourtPose);
  assert.equal(deepCourtPose.curbSupportId, "metro-courtyard");
  assert.ok(Math.abs(deepCourtPose.y - (-0.165)) < 1e-9);
  assert.equal(nearCurb(curb, deepCourtPose), true);

  // 3. Building overlap in world.statics is strictly blocked by sweepSafeWithCurbs ("occupied") and curbClearance ("curb-solid").
  const intoBuildingSweep = sweepSafeWithCurbs(
    { x: westBldg.x, z: -106, heading: 0, width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM },
    { x: westBldg.x, z: -96, heading: 0, width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM },
    world.statics, world.roads, curb,
  );
  assert.deepEqual(intoBuildingSweep, { safe: false, reason: "occupied", actor: westBldg.id });

  const bldgActor = {
    ...world.player,
    x: westBldg.x, z: westBox.minZ - PLAYER_VEHICLE.lengthM / 2 - 0.8,
    heading: 0, speed: 5.0, steer: 0, gtaSlipMps: 0, gtaYawRate: 0,
    curbSupportId: "tahrir-boulevard:pos:1",
  };
  const bldgNext = projectGta(bldgActor, { steer: 0, targetSpeed: 5.0 });
  assert.deepEqual(
    curbClearance(world, curb, { a: bldgActor, next: bldgNext, command: { steer: 0, targetSpeed: 5.0 }, travel: distance(bldgActor, bldgNext) }, [], projectGta),
    { reason: "curb-solid", blockedBy: westBldg.id },
  );

  // 4. Live drive from blocked tahrir-boulevard (z=-112) through alley (z=-93) with pedestrian yield/resume onto station-avenue (z=-75).
  const tahrirBlock = solid("dev-tahrir-shutter", -131, -112, 1.0, 14.0, 1.8, 0);
  world.statics.push(tahrirBlock);
  off.statics.push(solid("dev-tahrir-shutter", -131, -112, 1.0, 14.0, 1.8, 0));
  Object.assign(world.player, { x: -151, z: -109.3, heading: Math.PI / 2, speed: 0, steer: 0 });
  Object.assign(off.player, { x: -151, z: -109.3, heading: Math.PI / 2, speed: 0, steer: 0 });

  // Place pedestrian directly in the middle of the courtyard alley at (alleyX, -91.5).
  const alleyPed = world.actors.find(a => a.type === "pedestrian");
  Object.assign(alleyPed, { x: alleyX, z: -91.5, heading: Math.PI, speed: 0 });
  world.command({ type: "pedestrian-motion", mode: "stop", id: alleyPed.id });

  const view = new WorldView(world);
  t.after(() => view.dispose());
  const groundMesh = view.scene.children.find(obj => obj.isMesh && obj.position.y === -0.05);
  assert.ok(groundMesh, "expected WorldView -0.05 courtyard ground mesh");

  const alleyAction = p => {
    const targetHeading = p.z < -104 && Math.abs(p.x - alleyX) > 1.2
      ? Math.atan2(alleyX - p.x, -102 - p.z)
      : Math.atan((alleyX - p.x) * 0.45);
    return {
      steer: Math.max(-.62, Math.min(.62, angleDelta(targetHeading, p.heading) * 2.2)),
      throttle: p.speed < 6.5 ? .9 : 0,
      brake: 0,
      gear: 1,
    };
  };

  let pedYield = null, offBoundary = false;
  for (let i = 0; i < 420; i++) {
    drive(world, alleyAction(world.player));
    drive(off, alleyAction(off.player));
    assert.equal(overlaps(world.player, alleyPed), false);
    assert.equal(overlaps(world.player, westBldg), false);
    assert.equal(overlaps(world.player, eastBldg), false);
    if (off.player.reason === "road-boundary") offBoundary = true;
    if (world.player.reason === "curb-pedestrian") {
      pedYield ??= [world.tick, world.player.x, world.player.z, world.player.blockedBy];
    }
  }
  assert.ok(pedYield, "expected curb-pedestrian yield inside courtyard alley");
  assert.equal(pedYield[3], alleyPed.id);
  assert.ok(world.player.z < alleyPed.z - 2.0 && world.player.z > -103,
    `expected SUV stopped safely inside alley before pedestrian, got z=${world.player.z}`);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);
  assert.ok(offBoundary && off.player.z < -105, `expected off world blocked on tahrir-boulevard, got z=${off.player.z}`);

  // Move pedestrian clear and complete the alley crossing through z = -93 onto station-avenue (z = -75).
  Object.assign(alleyPed, { x: -175, z: -91.5, speed: 0 });
  let courtyardWheelSurvey = null, minCourtyardY = 0;
  for (let i = 0; i < 420 && world.player.z < -74.5; i++) {
    drive(world, alleyAction(world.player));
    assert.equal(overlaps(world.player, westBldg), false);
    assert.equal(overlaps(world.player, eastBldg), false);
    minCourtyardY = Math.min(minCourtyardY, world.player.y ?? 0);
    if (!courtyardWheelSurvey && Math.abs(world.player.z - (-93)) < 0.8) {
      const root = view.syncMetroPlayer(1);
      assert.ok(Math.abs(root.position.y - (0.12 - 0.165)) < 1e-6);
      const surfaces = [...view.surfaces.road, ...view.surfaces.pavement, groundMesh];
      courtyardWheelSurvey = ["front-left", "front-right", "rear-left", "rear-right"].map(name => {
        const pivot = root.getObjectByName(`wheel-${name}`).getWorldPosition(new Vector3());
        const ray = new Raycaster(new Vector3(pivot.x, 2, pivot.z), new Vector3(0, -1, 0));
        const surface = ray.intersectObjects(surfaces, false)[0].point.y;
        const tire = pivot.y - .35;
        assert.ok(Math.abs(tire - surface) < .008, `${name} tire ${tire} vs courtyard surface ${surface}`);
        return { name, tire, surface };
      });
      assert.ok(courtyardWheelSurvey.every(w => Math.abs(w.surface - (-0.05)) < 1e-6));
    }
  }
  assert.ok(courtyardWheelSurvey, "expected WorldView courtyard wheel raycast at z=-93");
  assert.ok(Math.abs(minCourtyardY - (-0.165)) < 1e-6, `expected -0.165 min courtyard Y, got ${minCourtyardY}`);
  assert.ok(world.player.z >= -75.5 && bodyOnRoad(world.player, world.roads),
    `expected SUV to emerge onto station-avenue asphalt, got z=${world.player.z}`);
  assert.equal(world.player.y, 0);
  assert.equal(world.player.supportHeightM, 0);
  assert.equal(world.player.curbSupportId, null);
  assert.equal(world.pursuit.metrics.shoulderEntries, 1);
  assert.equal(world.pursuit.metrics.shoulderExits, 1);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);
});
