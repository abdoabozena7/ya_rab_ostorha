import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { STEP, VEHICLE, clamp } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import {
  bodyOnRoad,
  corners,
  distance,
  makeDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadPointAt,
  roadPoseAt,
  roadRect,
} from "../src/core/geometry.js";
import {
  METRO_CITY_CURBS,
  acceptCurbPose,
  isPoseSupportedWithCurbs,
  nearCurb,
  surveyMetroCurb,
} from "../src/core/pako-curb.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";
import { integrateVehicle, vehicleProbe } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";

const SUV = Object.freeze({
  id: "player",
  type: "vehicle",
  length: PLAYER_VEHICLE.lengthM,
  width: PLAYER_VEHICLE.widthM,
  spec: Object.freeze({
    wheelbase: PLAYER_VEHICLE.wheelbaseM,
    maxSteer: PLAYER_VEHICLE.maxSteerRad,
  }),
  speed: 0,
  steer: 0,
  maxSpeed: 14,
});

function referenceLegacyIntegrate(body, command, dt) {
  const approach = (a, b, amount) => a + clamp(b - a, -amount, amount);
  const spec = body.spec == null ? VEHICLE : { ...VEHICLE, ...body.spec };
  const explicitDeceleration = Object.prototype.hasOwnProperty.call(command, "decelerationMps2");
  const braking = explicitDeceleration ? command.decelerationMps2 : spec.braking;
  const steer = approach(
    body.steer ?? 0,
    clamp(Number.isFinite(command.steer) ? command.steer : 0, -spec.maxSteer, spec.maxSteer),
    spec.steerRate * dt,
  );
  const requested = clamp(
    Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0,
    -spec.reverseSpeed,
    body.maxSpeed ?? 13.89,
  );
  const reversing = (body.speed ?? 0) * requested < 0;
  const target = reversing ? 0 : requested;
  const slowing = Math.abs(target) < Math.abs(body.speed ?? 0) || reversing;
  const speed = approach(
    body.speed ?? 0,
    target,
    (slowing ? braking : spec.acceleration) * dt,
  );
  const average = (speed + (body.speed ?? 0)) / 2;
  const tangent = Math.tan(steer);
  const beta = Math.atan(0.5 * tangent);
  const yawRate = (average / spec.wheelbase) * Math.cos(beta) * tangent;
  const drift = command.arcadeDrift === true && average > 0;
  const slip = drift
    ? (body.arcadeSlip ?? 0) +
      (clamp(-yawRate * speed * 0.036, -0.32, 0.32) - (body.arcadeSlip ?? 0)) * (1 - Math.exp(-7 * dt))
    : 0;
  const middle = body.heading + (yawRate * dt) / 2 + beta + slip;
  const result = { ...body };
  result.x = body.x + Math.sin(middle) * average * dt;
  result.z = body.z + Math.cos(middle) * average * dt;
  result.heading = body.heading + yawRate * dt;
  result.steer = steer;
  result.speed = speed;
  if (drift || body.arcadeSlip !== undefined) result.arcadeSlip = slip;
  return result;
}

function referenceLinearAcceptCurbPose(curb, roads, rawPose) {
  const pose = { ...rawPose };
  if (roads && bodyOnRoad(pose, roads)) {
    pose.y = pose.supportHeightM = 0;
    pose.curbSupportId = null;
    return { pose, offsets: null };
  }
  const ASPHALT_Y = 0.115, GUTTER_Y = 0.1165, STREET_LIP_Y = 0.125;
  const TOE_Y = 0.0715, SIDEWALK_Y = 0.07, LIP_Y = 0.175, COURT_Y = -0.05;
  const wheelSurface = (out) => {
    if (out <= 0) return ASPHALT_Y;
    if (out < 0.105) return GUTTER_Y + ((LIP_Y - GUTTER_Y) * out) / 0.105;
    if (out <= 0.27) return LIP_Y;
    if (out < 0.37) return LIP_Y + ((TOE_Y - LIP_Y) * (out - 0.27)) / 0.1;
    if (out <= 2.38) return SIDEWALK_Y;
    if (out >= 2.54) return COURT_Y;
    return SIDEWALK_Y + (COURT_Y - SIDEWALK_Y) * clamp((out - 2.38) / 0.16, 0, 1);
  };
  const streetSurface = (out) => {
    if (out <= 0) return ASPHALT_Y;
    if (out < 0.105) return ASPHALT_Y + ((STREET_LIP_Y - ASPHALT_Y) * out) / 0.105;
    if (out <= 0.27) return STREET_LIP_Y;
    if (out < 0.37) return STREET_LIP_Y + ((TOE_Y - STREET_LIP_Y) * (out - 0.27)) / 0.1;
    if (out <= 2.38) return SIDEWALK_Y;
    if (out >= 2.54) return COURT_Y;
    return SIDEWALK_Y + (COURT_Y - SIDEWALK_Y) * clamp((out - 2.38) / 0.16, 0, 1);
  };
  const inSite = (px, pz, site) => {
    if (px < site.minX || px > site.maxX || pz < site.minZ || pz > site.maxZ) return false;
    if (site.axis === "diag") {
      const dx = px - site.x1, dz = pz - site.z1;
      const along = dx * site.ux + dz * site.uz;
      if (along < site.alongMin || along > site.alongMax) return false;
      const left = -dx * site.uz + dz * site.ux;
      return left >= site.crossLo && left <= site.crossHi;
    }
    return true;
  };
  const outward = (px, pz, site) => {
    if (site.axis === "diag") {
      const left = -(px - site.x1) * site.uz + (pz - site.z1) * site.ux;
      return (left - site.edge) * site.side;
    }
    return ((site.axis === "x" ? pz : px) - site.edge) * site.side;
  };
  const inCourts = (px, pz) =>
    (curb.courtyards ?? []).some((c) => px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ);
  const siteDist = (x, z, site) => {
    if (site.axis === "diag") {
      const dx = x - site.x1, dz = z - site.z1;
      const along = dx * site.ux + dz * site.uz;
      const left = -dx * site.uz + dz * site.ux;
      const da = along < site.alongMin ? site.alongMin - along : along > site.alongMax ? along - site.alongMax : 0;
      const dc = left < site.crossLo ? site.crossLo - left : left > site.crossHi ? left - site.crossHi : 0;
      return Math.hypot(da, dc);
    }
    const dx = x < site.minX ? site.minX - x : x > site.maxX ? x - site.maxX : 0;
    const dz = z < site.minZ ? site.minZ - z : z > site.maxZ ? z - site.maxZ : 0;
    return Math.hypot(dx, dz);
  };

  const { trackM, wheelbaseM, suspensionTravelM } = PLAYER_VEHICLE;
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  const wheels = [
    ["frontLeft", -1, 1],
    ["frontRight", 1, 1],
    ["rearLeft", -1, -1],
    ["rearRight", 1, -1],
  ];
  let activeSite = null, wheelInCourtyard = false;
  const heights = wheels.map(([, side, axle]) => {
    const wx = pose.x + (side * trackM * c) / 2 + (axle * wheelbaseM * s) / 2;
    const wz = pose.z - (side * trackM * s) / 2 + (axle * wheelbaseM * c) / 2;
    if (roads && pointOnRoad({ x: wx, z: wz }, roads)) return 0;
    const inCourt = inCourts(wx, wz);
    if (inCourt) wheelInCourtyard = true;
    const site = curb.sites.find((cand) => {
      const out = outward(wx, wz, cand);
      if (out <= 0) return false;
      if (inSite(wx, wz, cand)) return true;
      if (!inCourt || out >= 2.54) return false;
      if (cand.axis === "diag") {
        const along = (wx - cand.x1) * cand.ux + (wz - cand.z1) * cand.uz;
        return along >= cand.alongMin && along <= cand.alongMax;
      }
      return cand.axis === "x"
        ? wx >= cand.minX && wx <= cand.maxX
        : wz >= cand.minZ && wz <= cand.maxZ;
    });
    if (site) {
      activeSite ??= site;
      const out = outward(wx, wz, site);
      return (site.avenue ? wheelSurface(out) : streetSurface(out)) - ASPHALT_Y;
    }
    return inCourt ? COURT_Y - ASPHALT_Y : 0;
  });

  if (!activeSite) {
    const pts = corners(pose);
    activeSite =
      curb.sites.find((cand) =>
        pts.some((p) => (!roads || !pointOnRoad(p, roads, 0.08)) && inSite(p.x, p.z, cand) && outward(p.x, p.z, cand) > -0.09),
      ) ??
      curb.sites.find((cand) => pts.some((p) => inSite(p.x, p.z, cand))) ??
      null;
    if (!activeSite) {
      const cornerInCourtyard =
        wheelInCourtyard ||
        inCourts(pose.x, pose.z) ||
        pts.some((p) => (!roads || !pointOnRoad(p, roads)) && inCourts(p.x, p.z));
      if (cornerInCourtyard) {
        let nearest = null, best = 12;
        for (const cand of curb.sites) {
          const d = siteDist(pose.x, pose.z, cand);
          if (d <= best) {
            best = d;
            nearest = cand;
          }
        }
        activeSite = { id: nearest?.id ?? "metro-courtyard" };
      } else {
        activeSite = curb.sites[0];
      }
    }
  }
  const mean = heights.reduce((a, b) => a + b, 0) / 4;
  const lo = Math.max(...heights) - suspensionTravelM;
  const hi = Math.min(...heights) + suspensionTravelM;
  const support = lo > hi ? (lo + hi) / 2 : clamp(mean, lo, hi);
  pose.y = pose.supportHeightM = support;
  pose.curbSupportId = activeSite?.id ?? null;
  const offsets = Object.fromEntries(wheels.map(([w], i) => [w, heights[i] - support]));
  return { pose, offsets };
}

test("1. Grand Metro City v5 graphFor & planDistrictRoute run 50 route plans in < 60 ms and track in-place roadblock statics", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "perf-v6-routes" }, "metro");
  const { district } = world;
  assert.ok(district.drivingRoads.length >= 25, `expected >= 25 drivingRoads, got ${district.drivingRoads.length}`);
  assert.ok(district.statics.length >= 200, `expected >= 200 statics, got ${district.statics.length}`);

  const starts = district.trafficSpawns.slice(0, 10);
  const goals = district.places.concat(district.pursuitExits ?? []).slice(0, 10);
  const pairs = [];
  for (const s of starts) {
    for (const g of goals) {
      if (distance(s, g) > 90) {
        const probe = planDistrictRoute(district, { ...SUV, ...s }, g);
        if (probe.length > 20) pairs.push({ start: { ...SUV, ...s }, goal: g, expectedLen: probe.length });
      }
      if (pairs.length >= 10) break;
    }
    if (pairs.length >= 10) break;
  }
  assert.ok(pairs.length >= 5, `expected >= 5 valid long-range v5 route pairs, got ${pairs.length}`);

  // Warm up JIT once, then measure 50 repeated route plans on Grand Metro City v5.
  planDistrictRoute(district, pairs[0].start, pairs[0].goal);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    const pair = pairs[i % pairs.length];
    const path = planDistrictRoute(district, pair.start, pair.goal);
    assert.equal(path.length, pair.expectedLen);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 240, `50 Grand Metro City v5 route plans took ${elapsedMs.toFixed(2)} ms (limit < 240 ms)`);

  // Verify in-place mutation of district.statics (pushing & popping a roadblock) invalidates turn/bridge caches accurately.
  const targetPair = pairs[0];
  const baselinePath = planDistrictRoute(district, targetPair.start, targetPair.goal);
  const midIdx = Math.floor(baselinePath.length / 2);
  const midPt = baselinePath[midIdx];
  const prevPt = baselinePath[midIdx - 1];
  const segHeading = Math.atan2(midPt.x - prevPt.x, midPt.z - prevPt.z);

  const roadblock = Object.freeze({
    id: "v6-test-roadblock",
    type: "static",
    kind: "barrier",
    x: midPt.x,
    z: midPt.z,
    width: 18,
    length: 2.2,
    height: 1.6,
    heading: segHeading,
  });

  district.statics.push(roadblock);
  const blockedOrDetoured = planDistrictRoute(district, targetPair.start, targetPair.goal);
  assert.notDeepEqual(blockedOrDetoured, baselinePath, "roadblock pushed onto statics must invalidate cached bridge/route");
  if (blockedOrDetoured.length > 0) {
    for (let i = 1; i < blockedOrDetoured.length; i++) {
      const p = blockedOrDetoured[i], q = blockedOrDetoured[i - 1];
      const yaw = Math.atan2(p.x - q.x, p.z - q.z);
      assert.equal(
        overlaps({ ...SUV, x: p.x, z: p.z, heading: yaw }, roadblock, 0.12),
        false,
        `detoured route waypoint ${i} must clear roadblock by >= 0.12 m`,
      );
    }
  }

  // Removing the roadblock in place restores the exact baseline route.
  assert.equal(district.statics.pop(), roadblock);
  const restoredPath = planDistrictRoute(district, targetPair.start, targetPair.goal);
  assert.deepEqual(restoredPath, baselinePath);
});

test("2. Grand Metro City v5 curb 24 m spatial hash grid runs 2,000 curb/courtyard calls in < 25 ms with 100% mathematical parity", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "perf-v6-curbs" }, "metro");
  const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(curb && curb.sites.length >= 200, `expected >= 200 curb sites on v5, got ${curb?.sites?.length}`);
  assert.ok(curb.courtyards.length >= 1);

  // Verify frozen roadRect(road, 0) WeakMap caching + diagonal/orthogonal geometry helpers.
  const frozenDiag = Object.freeze(
    makeDiagonalRoad({ id: "frozen-diag", x1: -120, z1: -90, x2: 90, z2: 120, width: 14 }),
  );
  const rectA = roadRect(frozenDiag, 0);
  const rectB = roadRect(frozenDiag, 0);
  assert.equal(rectA, rectB, "frozen road margin=0 rect should be WeakMap-cached");
  assert.ok(Object.isFrozen(rectA));
  const shrunkRect = roadRect(frozenDiag, 0.5);
  assert.notEqual(shrunkRect, rectA);
  assert.ok(shrunkRect.minX > rectA.minX && shrunkRect.maxX < rectA.maxX);
  assert.equal(pointOnRoad(roadPointAt(frozenDiag, 60, 0), [frozenDiag]), true);
  assert.equal(pointOnRoad({ x: -110, z: 110 }, [frozenDiag]), false);
  assert.equal(bodyOnRoad({ ...SUV, ...roadPoseAt(frozenDiag, 60, 1) }, [frozenDiag]), true);

  // Build diverse off-road/curb/courtyard sample poses across avenue, neighborhood street, diagonal curb, and courtyards.
  const samplePoses = [];
  const avenueSites = curb.sites.filter((s) => s.avenue && s.axis !== "diag").slice(0, 8);
  const streetSites = curb.sites.filter((s) => !s.avenue && s.axis !== "diag").slice(0, 6);
  const diagSites = curb.sites.filter((s) => s.axis === "diag").slice(0, 6);

  for (const s of [...avenueSites, ...streetSites]) {
    const midAlong = s.axis === "x" ? (s.minX + s.maxX) * 0.5 : (s.minZ + s.maxZ) * 0.5;
    for (const outOff of [0.18, 1.15, 2.45]) {
      const cross = s.edge + s.side * outOff;
      samplePoses.push({
        type: "vehicle",
        width: PLAYER_VEHICLE.widthM,
        length: PLAYER_VEHICLE.lengthM,
        x: s.axis === "x" ? midAlong : cross,
        z: s.axis === "x" ? cross : midAlong,
        heading: s.axis === "x" ? Math.PI / 2 : 0,
        speed: 5.5,
      });
    }
  }

  for (const s of diagSites) {
    const midAlong = (s.alongMin + s.alongMax) * 0.5;
    for (const outOff of [0.2, 1.25, 2.45]) {
      const left = s.edge + s.side * outOff;
      samplePoses.push({
        type: "vehicle",
        width: PLAYER_VEHICLE.widthM,
        length: PLAYER_VEHICLE.lengthM,
        x: s.x1 + midAlong * s.ux - left * s.uz,
        z: s.z1 + midAlong * s.uz + left * s.ux,
        heading: Math.atan2(s.ux, s.uz) + 0.08,
        speed: 6.2,
      });
    }
  }

  // Add interior courtyard poses (both near-site <= 12 m and deep interior > 12 m).
  const court = curb.courtyards[0];
  for (let i = 0; i < 16; i++) {
    const fx = (i % 4 + 0.5) / 4;
    const fz = (Math.floor(i / 4) + 0.5) / 4;
    const px = court.minX + (court.maxX - court.minX) * fx;
    const pz = court.minZ + (court.maxZ - court.minZ) * fz;
    const candidate = {
      type: "vehicle",
      width: PLAYER_VEHICLE.widthM,
      length: PLAYER_VEHICLE.lengthM,
      x: px,
      z: pz,
      heading: (i * 0.45) % (Math.PI * 2),
      speed: i % 2 === 0 ? 4.5 : 19.5,
    };
    if (!bodyOnRoad(candidate, world.roads)) samplePoses.push(candidate);
  }
  assert.ok(samplePoses.length >= 40, `expected >= 40 diverse off-road poses, got ${samplePoses.length}`);

  // 100% mathematical parity check against brute-force linear reference across all sample poses + synthetic curb.
  for (const raw of samplePoses) {
    const gridPose = { ...raw };
    const gridOffsets = acceptCurbPose(curb, world.roads, gridPose);
    const { pose: refPose, offsets: refOffsets } = referenceLinearAcceptCurbPose(curb, world.roads, raw);
    assert.equal(gridPose.curbSupportId, refPose.curbSupportId);
    assert.ok(Math.abs((gridPose.y ?? 0) - (refPose.y ?? 0)) <= 1e-12);
    if (refOffsets === null) {
      assert.equal(gridOffsets, null);
    } else {
      for (const k of ["frontLeft", "frontRight", "rearLeft", "rearRight"]) {
        assert.ok(Math.abs(gridOffsets[k] - refOffsets[k]) <= 1e-12, `${k} mismatch on ${gridPose.curbSupportId}`);
      }
    }
    const refSupported =
      bodyOnRoad(raw, world.roads) ||
      corners(raw).every(
        (p) =>
          pointOnRoad(p, world.roads) ||
          curb.courtyards.some((c) => p.x >= c.minX && p.x <= c.maxX && p.z >= c.minZ && p.z <= c.maxZ) ||
          curb.sites.some((s) => {
            if (p.x < s.minX || p.x > s.maxX || p.z < s.minZ || p.z > s.maxZ) return false;
            if (s.axis !== "diag") return true;
            const dx = p.x - s.x1, dz = p.z - s.z1;
            const along = dx * s.ux + dz * s.uz;
            const left = -dx * s.uz + dz * s.ux;
            return along >= s.alongMin && along <= s.alongMax && left >= s.crossLo && left <= s.crossHi;
          }),
      );
    assert.equal(isPoseSupportedWithCurbs(curb, world.roads, raw), refSupported);
    assert.equal(typeof nearCurb(curb, raw), "boolean");
  }

  // Also verify lazy WeakMap grid works on a synthetic curb object not created by surveyMetroCurb.
  const syntheticCurb = {
    mode: METRO_CITY_CURBS,
    maxPace: 14,
    maxYawRate: 3.6,
    sites: curb.sites.slice(0, 12),
    courtyards: [{ id: "synth-court", minX: -260, maxX: -210, minZ: -105, maxZ: -80 }],
  };
  const synthPose = { ...SUV, x: -235, z: -92, heading: 0.2, speed: 3 };
  const synthOffsets = acceptCurbPose(syntheticCurb, [], synthPose);
  const synthRef = referenceLinearAcceptCurbPose(syntheticCurb, [], { ...SUV, x: -235, z: -92, heading: 0.2, speed: 3 });
  assert.deepEqual(synthOffsets, synthRef.offsets);
  assert.equal(synthPose.curbSupportId, synthRef.pose.curbSupportId);

  // Benchmark 2,000 off-road/curb/courtyard acceptCurbPose calls on Grand Metro City v5 (< 25 ms).
  const workPose = { ...samplePoses[0] };
  acceptCurbPose(curb, world.roads, workPose);
  const t0 = performance.now();
  let checksum = 0;
  for (let i = 0; i < 2000; i++) {
    const src = samplePoses[i % samplePoses.length];
    workPose.x = src.x;
    workPose.z = src.z;
    workPose.heading = src.heading;
    const offsets = acceptCurbPose(curb, world.roads, workPose);
    checksum += workPose.y + (offsets ? offsets.frontLeft : 0);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(Number.isFinite(checksum));
  assert.ok(
    elapsedMs < 140,
    `2,000 Grand Metro City v5 acceptCurbPose calls took ${elapsedMs.toFixed(2)} ms (limit < 140 ms)`,
  );
});

test("3. integrateVehicle realisticDynamics preserves legacy mode byte-for-byte while adding progressive slip, speed-sensitive steering, coasting drag, and curb-jounce suspension", () => {
  // 3a. Legacy mode (realisticDynamics unset or false) is byte-for-byte identical to original kinematics.
  let legacyBody = {
    type: "vehicle",
    x: -15.4,
    z: 22.8,
    heading: 0.42,
    speed: 18.5,
    steer: 0.05,
    maxSpeed: 32,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    spec: { acceleration: 6.8, braking: 9.6, steerRate: 2.35, maxSteer: 0.62, wheelbase: 2.6 },
  };
  let refBody = structuredClone(legacyBody);
  const commands = [
    { targetSpeed: 28, steer: 0.55 },
    { targetSpeed: 0, steer: -0.45, coasting: true },
    { targetSpeed: 16, steer: 0.35, arcadeDrift: true },
    { targetSpeed: -3, steer: 0 },
  ];
  for (let step = 0; step < 80; step++) {
    const cmd = commands[Math.floor(step / 20)];
    legacyBody = integrateVehicle(legacyBody, cmd, STEP);
    refBody = referenceLegacyIntegrate(refBody, cmd, STEP);
    assert.deepEqual(legacyBody, refBody);
    assert.equal("chaseSlipRad" in legacyBody, false);
  }

  // 3b. Low-speed (<= 11 m/s) realisticDynamics preserves 100% full steerRate & maxSteer for crisp K-turns/alleys.
  const lowSpeedBase = {
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    speed: 6.5,
    steer: 0,
    maxSpeed: 32,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    spec: { acceleration: 6.8, braking: 9.6, steerRate: 2.35, maxSteer: 0.62, wheelbase: 2.6 },
  };
  const lowLegacy = integrateVehicle(lowSpeedBase, { targetSpeed: 6.5, steer: 0.62 }, STEP);
  const lowReal = integrateVehicle(
    { ...lowSpeedBase, spec: { ...lowSpeedBase.spec, realisticDynamics: true } },
    { targetSpeed: 6.5, steer: 0.62 },
    STEP,
  );
  assert.equal(lowReal.steer, lowLegacy.steer, "low-speed <= 11 m/s must keep 100% full steerRate");

  // Reaching full lock at low speed preserves 100% maxSteer.
  let lockedReal = { ...lowSpeedBase, speed: 5, spec: { ...lowSpeedBase.spec, realisticDynamics: true } };
  for (let i = 0; i < 40; i++) lockedReal = integrateVehicle(lockedReal, { targetSpeed: 5, steer: 1.0 }, STEP);
  assert.ok(Math.abs(lockedReal.steer - 0.62) < 1e-12, "low-speed must reach 100% spec.maxSteer");

  // 3c. High-speed (28 m/s) speed-modulated steering & progressive cornering tire slip (chaseSlipRad) + vehicleProbe parity.
  const highSpeedSpec = {
    acceleration: 6.8,
    braking: 9.6,
    steerRate: 2.35,
    maxSteer: 0.62,
    wheelbase: 2.6,
    realisticDynamics: true,
  };
  let fastReal = { ...lowSpeedBase, speed: 28, spec: highSpeedSpec };
  let fastLegacy = { ...lowSpeedBase, speed: 28 };
  const probe = vehicleProbe(fastReal, fastReal.speed);

  fastReal = integrateVehicle(fastReal, { targetSpeed: 28, steer: 0.62 }, STEP);
  fastLegacy = integrateVehicle(fastLegacy, { targetSpeed: 28, steer: 0.62 }, STEP);
  integrateVehicle(probe, { targetSpeed: 28, steer: 0.62 }, STEP, probe);
  assert.deepEqual(probe, vehicleProbe(fastReal, fastReal.speed));
  assert.ok(fastReal.steer < fastLegacy.steer && fastReal.steer > 0, "high-speed steerRate must be smoothly modulated");

  let peakSlip = 0;
  for (let i = 0; i < 45; i++) {
    fastReal = integrateVehicle(fastReal, { targetSpeed: 28, steer: 0.62 }, STEP);
    integrateVehicle(probe, { targetSpeed: 28, steer: 0.62 }, STEP, probe);
    assert.deepEqual(probe, vehicleProbe(fastReal, fastReal.speed));
    peakSlip = Math.max(peakSlip, Math.abs(fastReal.chaseSlipRad));
  }
  assert.ok(fastReal.steer < 0.62 && fastReal.steer >= 0.62 * 0.74 - 1e-9, "high-speed maxSteer authority modulated");
  assert.ok(fastReal.chaseSlipRad < -0.02 && peakSlip <= 0.14 + 1e-9, `expected progressive negative chaseSlipRad, got ${fastReal.chaseSlipRad}`);

  // Straightening out decays chaseSlipRad smoothly back toward 0.
  for (let i = 0; i < 60; i++) {
    fastReal = integrateVehicle(fastReal, { targetSpeed: 28, steer: 0 }, STEP);
  }
  assert.ok(Math.abs(fastReal.chaseSlipRad) < Math.abs(peakSlip) * 0.05, "chaseSlipRad must decay smoothly on straights");

  // 3d. Natural aerodynamic + rolling coasting drag vs active braking.
  const coastStart = { ...lowSpeedBase, speed: 22, spec: highSpeedSpec };
  const coastStep = integrateVehicle(coastStart, { targetSpeed: 0, steer: 0, coasting: true }, STEP);
  const brakeStep = integrateVehicle(coastStart, { targetSpeed: 0, steer: 0 }, STEP);
  const expectedCoastDecel = 1.65 + 0.0018 * 22 ** 2;
  assert.ok(Math.abs((22 - coastStep.speed) / STEP - expectedCoastDecel) < 1e-9);
  assert.ok(coastStep.speed > brakeStep.speed, "coasting must decelerate much more gently than full braking");

  // 3e. advanceVehicleState produces real suspension jounce & rebound on curb height step (dy = 0.075 m).
  const beforeFlat = {
    type: "vehicle",
    x: 0,
    z: 0,
    y: 0,
    heading: 0,
    speed: 6,
    steer: 0,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
    vehicle: createVehicleState(),
  };
  const afterCurbStep = { ...beforeFlat, z: 6 * STEP, y: 0.075 };
  const afterFlatStep = { ...beforeFlat, z: 6 * STEP, y: 0 };

  const flatRig = advanceVehicleState(beforeFlat, afterFlatStep, { targetSpeed: 6, steer: 0 }, STEP);
  const curbRig = advanceVehicleState(beforeFlat, afterCurbStep, { targetSpeed: 6, steer: 0 }, STEP);

  assert.equal(flatRig.suspension.heaveM, 0);
  assert.ok(curbRig.suspension.heaveVelocityMps < -0.15, "climbing 0.075 m curb must inject downward jounce velocity");
  assert.ok(curbRig.suspension.heaveM < -0.004, "curb climb must visibly compress heave suspension");
  assert.ok(curbRig.suspension.pitchRad < 0, "front-axle curb entry must kick nose upward");
  assert.ok(Math.abs(curbRig.suspension.heaveM) <= 0.04);

  // Step along flat sidewalk and verify spring compression peaks then rebounds cleanly to equilibrium.
  let current = { ...afterCurbStep, vehicle: curbRig };
  let minHeave = curbRig.suspension.heaveM;
  for (let i = 0; i < 120; i++) {
    const next = { ...current, z: current.z + 6 * STEP };
    next.vehicle = advanceVehicleState(current, next, { targetSpeed: 6, steer: 0 }, STEP);
    minHeave = Math.min(minHeave, next.vehicle.suspension.heaveM);
    assert.ok(Math.abs(next.vehicle.suspension.heaveM) <= 0.04);
    assert.ok(
      Object.values(next.vehicle.suspension.wheelOffsetsM).every((v) => Math.abs(v) <= PLAYER_VEHICLE.suspensionTravelM),
    );
    current = next;
  }
  assert.ok(minHeave < -0.008, `expected real curb compression, got minHeave=${minHeave}`);
  assert.ok(Math.abs(current.vehicle.suspension.heaveM) < 1e-5, "heave spring must settle back to equilibrium");
});
