import { STEP, clamp } from "./config.js";
import { angleDelta, corners, overlaps, pointOnRoad } from "./geometry.js";
import { PLAYER_VEHICLE, playerVehicleDimensions, staticVehicleWheelLoadN } from "./vehicle-spec.js";

export const WHEEL_SCRUB_MODE = "wheel-scrub-v1";

const WHEEL_NAMES = Object.freeze([
  "frontLeft",
  "frontRight",
  "rearLeft",
  "rearRight",
]);

const WHEEL_LAYOUT = Object.freeze([
  ["frontLeft", -1, 1],
  ["frontRight", 1, 1],
  ["rearLeft", -1, -1],
  ["rearRight", 1, -1],
]);

const CURB_CELL_M = 24;
const CURB_INV_CELL = 1 / CURB_CELL_M;

const contactSlideMap = new WeakMap();
const contactContextMap = new WeakMap();
const curbScrubGridCache = new WeakMap();
const actorImpactReactions = new WeakMap();

const INACTIVE_ACTOR_REACTION = Object.freeze({
  active: false,
  rollRad: 0,
  pitchRad: 0,
  heaveM: 0,
  lateralPushMps: 0,
  yawPushRadS: 0,
});

function cleanZero(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-12) return 0;
  return Object.is(value, -0) ? 0 : value;
}

function round4(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function getContactSlide(body) {
  return body ? contactSlideMap.get(body) ?? 0 : 0;
}

export function setContactSlide(body, slide) {
  if (!body) return;
  if (Number.isFinite(slide) && Math.abs(slide) > 1e-12) {
    contactSlideMap.set(body, slide);
  } else {
    contactSlideMap.delete(body);
  }
}

export function deleteContactSlide(body) {
  if (body) contactSlideMap.delete(body);
}

export function copyContactSlide(source, target) {
  if (!target) return target;
  if (source && contactSlideMap.has(source)) {
    contactSlideMap.set(target, contactSlideMap.get(source));
  } else {
    contactSlideMap.delete(target);
  }
  return target;
}

export function registerContactContext(contact, context) {
  if (contact && context) contactContextMap.set(contact, context);
  return contact;
}

export const PARKED_BREAKAWAY_MPS = 1.35;
export const PARKED_GROUND_MU = 0.72;

export function resolveVehicleBodyMassKg(obstacle) {
  if (!obstacle) return 1450;
  if (Number.isFinite(obstacle.spec?.massKg) && obstacle.spec.massKg > 0) {
    return obstacle.spec.massKg;
  }
  const kind = obstacle.vehicleKind ?? obstacle.kind;
  if (kind === "tuktuk") return 620;
  if (kind === "bus" || kind === "truck") return 3200;
  if (kind === "van") return 2150;
  if (kind === "pickup") return 2050;
  if (kind === "suv") return 1920;
  return 1450;
}

export function resolveObstacleContactMechanics(
  egoMassKg,
  obstacle,
  closingSpeedMps,
  scrubEnabled,
  dt = STEP,
) {
  const mEgo = Number.isFinite(egoMassKg) && egoMassKg > 0 ? egoMassKg : PLAYER_VEHICLE.massKg;
  const closing = Math.max(0, Number.isFinite(closingSpeedMps) ? closingSpeedMps : 0);
  const isMovingVehicle = obstacle?.type === "vehicle";
  const isParkedVehicle = obstacle?.kind === "parked-vehicle";
  if (isMovingVehicle) {
    const mObs = resolveVehicleBodyMassKg(obstacle);
    const obsShare = mObs / (mEgo + mObs);
    const reducedMassKg = (mEgo * mObs) / (mEgo + mObs);
    const normalImpulseNs = reducedMassKg * closing;
    return {
      isVehicle: true,
      isParkedVehicle: false,
      stictionBroken: true,
      obsMassKg: mObs,
      obsMomentumShare: obsShare,
      reducedMassKg,
      groundHoldDv: 0,
      freeClosingMps: closing,
      egoNormalDelta: scrubEnabled ? obsShare * closing : closing,
      egoNormalImpulseNs: scrubEnabled ? normalImpulseNs : mEgo * closing,
      actorNetNormalImpulseNs: normalImpulseNs,
    };
  }
  if (isParkedVehicle && scrubEnabled && closing >= PARKED_BREAKAWAY_MPS) {
    const mObs = resolveVehicleBodyMassKg(obstacle);
    const obsShare = mObs / (mEgo + mObs);
    const reducedMassKg = (mEgo * mObs) / (mEgo + mObs);
    const groundHoldDv = Math.min(closing * 0.35, PARKED_GROUND_MU * 9.81 * dt * 4.5);
    const freeClosingMps = Math.max(0, closing - groundHoldDv);
    const freeImpulseNs = reducedMassKg * freeClosingMps;
    const groundImpulseNs = mEgo * groundHoldDv;
    return {
      isVehicle: true,
      isParkedVehicle: true,
      stictionBroken: true,
      obsMassKg: mObs,
      obsMomentumShare: obsShare,
      reducedMassKg,
      groundHoldDv,
      freeClosingMps,
      egoNormalDelta: groundHoldDv + obsShare * freeClosingMps,
      egoNormalImpulseNs: groundImpulseNs + freeImpulseNs,
      actorNetNormalImpulseNs: freeImpulseNs,
    };
  }
  return {
    isVehicle: isParkedVehicle,
    isParkedVehicle,
    stictionBroken: false,
    obsMassKg: isParkedVehicle ? resolveVehicleBodyMassKg(obstacle) : Infinity,
    obsMomentumShare: 0,
    reducedMassKg: mEgo,
    groundHoldDv: closing,
    freeClosingMps: 0,
    egoNormalDelta: closing,
    egoNormalImpulseNs: mEgo * closing,
    actorNetNormalImpulseNs: 0,
  };
}

export function computeWheelWorldPositions(pose) {
  let x = Number.isFinite(pose?.x) ? pose.x : 0;
  let z = Number.isFinite(pose?.z) ? pose.z : 0;
  const heading = Number.isFinite(pose?.heading) ? pose.heading : 0;
  const scale = Number.isFinite(pose?.giantScale) && pose.giantScale > 0 ? pose.giantScale : 1;
  const dimensions = playerVehicleDimensions(pose);
  const halfTrack = (dimensions.trackM * scale) / 2;
  const halfWheelbase = (dimensions.wheelbaseM * scale) / 2;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  if (dimensions.axleCenterZM) {
    x += dimensions.axleCenterZM * scale * s;
    z += dimensions.axleCenterZM * scale * c;
  }
  const ct = c * halfTrack;
  const st = s * halfTrack;
  const cw = c * halfWheelbase;
  const sw = s * halfWheelbase;
  return {
    frontLeft: { x: cleanZero(x - ct + sw), z: cleanZero(z + st + cw) },
    frontRight: { x: cleanZero(x + ct + sw), z: cleanZero(z - st + cw) },
    rearLeft: { x: cleanZero(x - ct - sw), z: cleanZero(z + st - cw) },
    rearRight: { x: cleanZero(x + ct - sw), z: cleanZero(z - st - cw) },
  };
}

function curbCellKey(cx, cz) {
  return (cx << 16) ^ (cz & 0xffff);
}

function buildCurbScrubGrid(curb) {
  const sites = curb.sites ?? [];
  const cells = new Map();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const x0 = (s.axis === "z" ? Math.min(s.minX, s.edge) : s.minX) - 1.5;
    const x1 = (s.axis === "z" ? Math.max(s.maxX, s.edge) : s.maxX) + 1.5;
    const z0 = (s.axis === "x" ? Math.min(s.minZ, s.edge) : s.minZ) - 1.5;
    const z1 = (s.axis === "x" ? Math.max(s.maxZ, s.edge) : s.maxZ) + 1.5;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
    const cx0 = Math.floor(x0 * CURB_INV_CELL);
    const cx1 = Math.floor(x1 * CURB_INV_CELL);
    const cz0 = Math.floor(z0 * CURB_INV_CELL);
    const cz1 = Math.floor(z1 * CURB_INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      const hi = cx << 16;
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = hi ^ (cz & 0xffff);
        const bucket = cells.get(key);
        if (bucket) bucket.push(s);
        else cells.set(key, [s]);
      }
    }
  }

  const grid = {
    sitesRef: curb.sites,
    sitesLen: sites.length,
    cells,
    minX,
    maxX,
    minZ,
    maxZ,
  };
  curbScrubGridCache.set(curb, grid);
  return grid;
}

function getCurbScrubSitesNear(curb, x, z) {
  if (!curb) return null;
  if (!Array.isArray(curb.sites)) return [curb];
  let grid = curbScrubGridCache.get(curb);
  if (
    !grid ||
    grid.sitesRef !== curb.sites ||
    grid.sitesLen !== curb.sites.length
  ) {
    grid = buildCurbScrubGrid(curb);
  }
  if (x < grid.minX || x > grid.maxX || z < grid.minZ || z > grid.maxZ) {
    return null;
  }
  return (
    grid.cells.get(
      curbCellKey(Math.floor(x * CURB_INV_CELL), Math.floor(z * CURB_INV_CELL)),
    ) ?? null
  );
}

function normalizeSingleSite(site) {
  if (!site) return null;
  if (site.axis === "x" || site.axis === "z" || site.axis === "diag") return site;
  if (Number.isFinite(site.edgeZ)) {
    return {
      axis: "x",
      side: 1,
      edge: site.edgeZ,
      minX: site.minX ?? -Infinity,
      maxX: site.maxX ?? Infinity,
      minZ: site.minZ ?? -Infinity,
      maxZ: site.maxZ ?? Infinity,
    };
  }
  if (Number.isFinite(site.edgeX)) {
    return {
      axis: "z",
      side: 1,
      edge: site.edgeX,
      minX: site.minX ?? -Infinity,
      maxX: site.maxX ?? Infinity,
      minZ: site.minZ ?? -Infinity,
      maxZ: site.maxZ ?? Infinity,
    };
  }
  return null;
}

function pointInCurbSite(px, pz, rawSite) {
  const site = normalizeSingleSite(rawSite);
  if (!site) return false;
  if (px < site.minX || px > site.maxX || pz < site.minZ || pz > site.maxZ) {
    return false;
  }
  if (site.axis === "diag") {
    const dx = px - site.x1;
    const dz = pz - site.z1;
    const along = dx * site.ux + dz * site.uz;
    if (along < site.alongMin || along > site.alongMax) return false;
    const leftOffset = -dx * site.uz + dz * site.ux;
    return leftOffset >= site.crossLo && leftOffset <= site.crossHi;
  }
  return true;
}

function curbSiteOutwardM(px, pz, rawSite) {
  const site = normalizeSingleSite(rawSite);
  if (!site) return -Infinity;
  const side = site.side >= 0 ? 1 : -1;
  if (site.axis === "diag") {
    const leftOffset = -(px - site.x1) * site.uz + (pz - site.z1) * site.ux;
    return (leftOffset - site.edge) * side;
  }
  return ((site.axis === "x" ? pz : px) - site.edge) * side;
}

function curbStreetNormal(rawSite) {
  const site = normalizeSingleSite(rawSite);
  if (!site) return { nx: 0, nz: 0 };
  const side = site.side >= 0 ? 1 : -1;
  if (site.axis === "diag") {
    const len = Math.hypot(site.ux, site.uz) || 1;
    return {
      nx: cleanZero((site.uz * side) / len),
      nz: cleanZero((-site.ux * side) / len),
    };
  }
  if (site.axis === "x") {
    return { nx: 0, nz: side > 0 ? -1 : 1 };
  }
  return { nx: side > 0 ? -1 : 1, nz: 0 };
}

function inactiveCurbScrub(after) {
  return {
    adjustedPose: after,
    active: false,
    kind: "none",
    wheel: null,
    side: null,
    attackAngleRad: 0,
    grazing: false,
    intensity: 0,
    tangentialSpeedMps: 0,
    worldX: cleanZero(after?.x ?? 0),
    worldZ: cleanZero(after?.z ?? 0),
    normalX: 0,
    normalZ: 0,
    steerKickRad: 0,
    rollImpulse: 0,
    pitchImpulse: 0,
    heaveImpulse: 0,
  };
}

export function computeCurbWheelScrub(
  before,
  after,
  curb,
  roads,
  dt = STEP,
  { applyDeflection = true } = {},
) {
  if (!after || !curb || !Number.isFinite(dt) || dt <= 0) {
    return inactiveCurbScrub(after);
  }

  const prevPose = before ?? after;
  const afterSpeed = Number.isFinite(after.speed) ? after.speed : 0;
  const beforeSpeed = Number.isFinite(prevPose.speed) ? prevPose.speed : afterSpeed;
  const avgSpeed = (afterSpeed + beforeSpeed) * 0.5;
  const absSpeed = Math.max(Math.abs(afterSpeed), Math.abs(avgSpeed));
  const bodyTravel = Math.hypot(
    (after.x ?? 0) - (prevPose.x ?? 0),
    (after.z ?? 0) - (prevPose.z ?? 0),
  );
  if (absSpeed < 0.05 && bodyTravel < 1e-4) {
    return inactiveCurbScrub(after);
  }

  const wheelsBefore = computeWheelWorldPositions(prevPose);
  const wheelsAfter = computeWheelWorldPositions(after);
  const hasRoads = Array.isArray(roads) && roads.length > 0;
  const dirSign = (afterSpeed !== 0 ? afterSpeed : beforeSpeed) < 0 ? -1 : 1;

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
    const [wheelName, sideSign, axleSign] = WHEEL_LAYOUT[i];
    const wBefore = wheelsBefore[wheelName];
    const wAfter = wheelsAfter[wheelName];

    if (hasRoads && pointOnRoad(wAfter, roads)) continue;

    const candidates = getCurbScrubSitesNear(curb, wAfter.x, wAfter.z);
    if (!candidates) continue;

    const beforeOnRoad = hasRoads && pointOnRoad(wBefore, roads);
    for (let j = 0; j < candidates.length; j++) {
      const rawSite = candidates[j];
      if (!pointInCurbSite(wAfter.x, wAfter.z, rawSite)) continue;

      const outAfter = curbSiteOutwardM(wAfter.x, wAfter.z, rawSite);
      if (!(outAfter > 0)) continue;

      const outBefore = curbSiteOutwardM(wBefore.x, wBefore.z, rawSite);
      const onCurbBand = outAfter > 0 && outAfter < 0.38;
      const crossedLip =
        outAfter >= 0.38 &&
        (beforeOnRoad || !pointInCurbSite(wBefore.x, wBefore.z, rawSite) || outBefore <= 0.05);
      if (!onCurbBand && !crossedLip) continue;

      // Peak engagement near the stone curb face/lip (0.08..0.28 m).
      const bandProfile = onCurbBand
        ? 1 - Math.abs(clamp(outAfter, 0.02, 0.36) - 0.17) / 0.25
        : 0.85;
      const leadBias = axleSign * dirSign > 0 ? 1.08 : 0.96;
      const score = bandProfile * leadBias;
      if (score > bestScore) {
        bestScore = score;
        best = {
          wheel: wheelName,
          side: sideSign < 0 ? "left" : "right",
          sideSign,
          axleSign,
          wBefore,
          wAfter,
          outAfter,
          site: rawSite,
        };
      }
    }
  }

  if (!best) {
    return inactiveCurbScrub(after);
  }

  const { nx, nz } = curbStreetNormal(best.site);
  const dwx = best.wAfter.x - best.wBefore.x;
  const dwz = best.wAfter.z - best.wBefore.z;
  const dwLen = Math.hypot(dwx, dwz);
  let wheelDirX;
  let wheelDirZ;
  if (dwLen > 1e-5) {
    wheelDirX = dwx / dwLen;
    wheelDirZ = dwz / dwLen;
  } else {
    const steerAngle = best.axleSign > 0 ? (after.steer ?? 0) : 0;
    const wh = (after.heading ?? 0) + steerAngle;
    wheelDirX = Math.sin(wh) * dirSign;
    wheelDirZ = Math.cos(wh) * dirSign;
  }

  const attackAngle = cleanZero(
    Math.asin(clamp(-(wheelDirX * nx + wheelDirZ * nz), -1, 1)),
  );
  const absAttack = Math.abs(attackAngle);
  const grazing = absAttack < 0.40 && absSpeed > 0.5;
  const tangentialSpeedMps = cleanZero(Math.abs(absSpeed * Math.cos(attackAngle)));

  const h = after.heading ?? 0;
  // The same curb step takes up more of a smaller tire radius.
  const radiusRatio = PLAYER_VEHICLE.wheelRadiusM / playerVehicleDimensions(after).wheelRadiusM;
  const bodyDirX = Math.sin(h) * dirSign;
  const bodyDirZ = Math.cos(h) * dirSign;
  const bodyAttack = Math.asin(clamp(-(bodyDirX * nx + bodyDirZ * nz), -1, 1));
  const rawAlignSign = Math.sign(dirSign * (Math.cos(h) * nx - Math.sin(h) * nz));
  const alignSign = rawAlignSign !== 0 ? rawAlignSign : -best.sideSign * dirSign;

  let adjustedPose = after;
  let intensity;
  let steerKickRad;
  let rollImpulse;
  let pitchImpulse;
  let heaveImpulse;

  if (grazing) {
    intensity = clamp((absSpeed / 12) * (1 - absAttack / 0.42), 0.08, 1.0);
    if (applyDeflection) {
      const absAfterSpeed = Math.abs(afterSpeed);
      const speedLoss = Math.min(
        absAfterSpeed * 0.32,
        (1.9 + 0.15 * absAfterSpeed) * intensity * dt,
      );
      const nextSpeedMag = Math.max(0, absAfterSpeed - speedLoss);
      const nextSpeed = afterSpeed === 0 ? 0 : Math.sign(afterSpeed) * nextSpeedMag;

      const maxYawStep = 0.85 * intensity * dt;
      let yawMag = 0;
      if (bodyAttack > 0) {
        yawMag = Math.min(maxYawStep, bodyAttack * 0.92 + 0.002);
      } else if (bodyAttack > -0.04) {
        yawMag = maxYawStep * 0.35;
      }
      const yawDelta = alignSign * yawMag;
      const speedScale = absAfterSpeed > 1e-6 ? nextSpeedMag / absAfterSpeed : 1;
      const streetNudge = Math.min(
        Math.max(0, best.outAfter) * 0.25,
        0.3 * intensity * dt,
      );
      adjustedPose = {
        ...after,
        x: (prevPose.x ?? after.x) + ((after.x ?? 0) - (prevPose.x ?? 0)) * speedScale + nx * streetNudge,
        z: (prevPose.z ?? after.z) + ((after.z ?? 0) - (prevPose.z ?? 0)) * speedScale + nz * streetNudge,
        heading: h + yawDelta,
        speed: cleanZero(nextSpeed),
      };
    }

    steerKickRad = cleanZero(alignSign * 0.085 * intensity);
    // Lifting curb-side wheel: +rollRad lifts right side, -rollRad lifts left side.
    rollImpulse = cleanZero(best.sideSign * 0.30 * intensity);
    pitchImpulse = cleanZero(-best.axleSign * 0.14 * intensity);
    heaveImpulse = cleanZero(-0.12 * intensity);
  } else {
    intensity = clamp(
      (absSpeed / 10) * (0.55 + 0.45 * Math.sin(Math.min(Math.PI / 2, absAttack))) * radiusRatio,
      0.12,
      1.0,
    );
    const climbedStep = (after.y ?? 0) > (prevPose.y ?? 0) + 0.002;
    if (applyDeflection && climbedStep) {
      const absAfterSpeed = Math.abs(afterSpeed);
      const speedLoss = Math.min(absAfterSpeed * 0.18, 1.15 * dt * radiusRatio);
      const nextSpeedMag = Math.max(0, absAfterSpeed - speedLoss);
      const nextSpeed = afterSpeed === 0 ? 0 : Math.sign(afterSpeed) * nextSpeedMag;
      const speedScale = absAfterSpeed > 1e-6 ? nextSpeedMag / absAfterSpeed : 1;
      adjustedPose = {
        ...after,
        x: (prevPose.x ?? after.x) + ((after.x ?? 0) - (prevPose.x ?? 0)) * speedScale,
        z: (prevPose.z ?? after.z) + ((after.z ?? 0) - (prevPose.z ?? 0)) * speedScale,
        speed: cleanZero(nextSpeed),
      };
    }

    steerKickRad = cleanZero(
      alignSign * 0.035 * intensity * Math.cos(Math.min(Math.PI / 2, absAttack)),
    );
    rollImpulse = cleanZero(best.sideSign * 0.42 * intensity);
    pitchImpulse = cleanZero(-best.axleSign * 0.24 * intensity);
    heaveImpulse = cleanZero(-0.22 * intensity);
  }

  const finalWheels = adjustedPose === after
    ? wheelsAfter
    : computeWheelWorldPositions(adjustedPose);
  const contactWheelPos = finalWheels[best.wheel];

  return {
    adjustedPose,
    active: true,
    kind: "curb",
    wheel: best.wheel,
    side: best.side,
    attackAngleRad: attackAngle,
    grazing,
    intensity: cleanZero(intensity),
    tangentialSpeedMps,
    worldX: contactWheelPos.x,
    worldZ: contactWheelPos.z,
    normalX: nx,
    normalZ: nz,
    steerKickRad,
    rollImpulse,
    pitchImpulse,
    heaveImpulse,
  };
}

function closestPointOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  const qx = ax + dx * t;
  const qz = az + dz * t;
  return { x: qx, z: qz, dist: Math.hypot(px - qx, pz - qz) };
}

function closestPointOnPolygon(px, pz, poly) {
  let bestX = poly[0].x;
  let bestZ = poly[0].z;
  let bestDist = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const res = closestPointOnSegment(px, pz, a.x, a.z, b.x, b.z);
    if (res.dist < bestDist) {
      bestDist = res.dist;
      bestX = res.x;
      bestZ = res.z;
    }
  }
  return { x: bestX, z: bestZ, dist: bestDist };
}

function resolveHullContactPatch(egoPose, obstacle, normal) {
  const halfWidth = (egoPose.width ?? PLAYER_VEHICLE.widthM) / 2;
  const halfLength = (egoPose.length ?? PLAYER_VEHICLE.lengthM) / 2;
  const heading = egoPose.heading ?? 0;
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  const egoCorners = corners(egoPose);

  const candidates = [];
  if (obstacle.type === "pedestrian" || (!obstacle.width && !obstacle.length && obstacle.radius)) {
    const res = closestPointOnPolygon(obstacle.x, obstacle.z, egoCorners);
    candidates.push({ x: res.x, z: res.z, dist: Math.max(0, res.dist - (obstacle.radius ?? 0)) });
  } else {
    const obsCorners = corners({
      x: obstacle.x,
      z: obstacle.z,
      heading: obstacle.heading ?? 0,
      width: obstacle.width ?? (obstacle.radius ?? 0.5) * 2,
      length: obstacle.length ?? (obstacle.radius ?? 0.5) * 2,
    });
    for (let i = 0; i < egoCorners.length; i++) {
      const p = egoCorners[i];
      const res = closestPointOnPolygon(p.x, p.z, obsCorners);
      candidates.push({ x: p.x, z: p.z, dist: res.dist });
    }
    for (let j = 0; j < obsCorners.length; j++) {
      const q = obsCorners[j];
      const res = closestPointOnPolygon(q.x, q.z, egoCorners);
      candidates.push({ x: res.x, z: res.z, dist: res.dist });
    }
  }

  let dMin = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].dist < dMin) dMin = candidates[i].dist;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minFwd = Infinity;
  let maxFwd = -Infinity;
  const tol = dMin + 0.025;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (cand.dist > tol) continue;
    const dx = cand.x - egoPose.x;
    const dz = cand.z - egoPose.z;
    const lat = clamp(dx * c - dz * s, -halfWidth, halfWidth);
    const fwd = clamp(dx * s + dz * c, -halfLength, halfLength);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (fwd < minFwd) minFwd = fwd;
    if (fwd > maxFwd) maxFwd = fwd;
  }

  let lateralOffsetM = Number.isFinite(minLat) ? (minLat + maxLat) * 0.5 : 0;
  let forwardOffsetM = Number.isFinite(minFwd) ? (minFwd + maxFwd) * 0.5 : 0;
  if (Math.abs(lateralOffsetM) < 1e-6) lateralOffsetM = 0;
  if (Math.abs(forwardOffsetM) < 1e-6) forwardOffsetM = 0;

  // Guarantee the resolved point sits directly on the SUV hull perimeter.
  const distToSide = halfWidth - Math.abs(lateralOffsetM);
  const distToEnd = halfLength - Math.abs(forwardOffsetM);
  if (distToSide > 1e-4 && distToEnd > 1e-4) {
    const nRight = normal.x * c - normal.z * s;
    const nFwd = normal.x * s + normal.z * c;
    if (Math.abs(nRight) >= Math.abs(nFwd)) {
      lateralOffsetM = (nRight >= 0 ? 1 : -1) * halfWidth;
    } else {
      forwardOffsetM = (nFwd >= 0 ? 1 : -1) * halfLength;
    }
  }

  const worldX = cleanZero(egoPose.x + lateralOffsetM * c + forwardOffsetM * s);
  const worldZ = cleanZero(egoPose.z - lateralOffsetM * s + forwardOffsetM * c);

  const wheels = computeWheelWorldPositions(egoPose);
  let closestWheel = "frontLeft";
  let bestWheelDist = Infinity;
  for (let i = 0; i < WHEEL_NAMES.length; i++) {
    const name = WHEEL_NAMES[i];
    const wp = wheels[name];
    const d = Math.hypot(worldX - wp.x, worldZ - wp.z);
    if (d < bestWheelDist - 1e-9) {
      bestWheelDist = d;
      closestWheel = name;
    }
  }

  return {
    lateralOffsetM,
    forwardOffsetM,
    worldX,
    worldZ,
    wheel: closestWheel,
  };
}

export function applyScrapingContactResponse(before, baseContact, obstacle, dt = STEP) {
  if (!baseContact || !obstacle || !Number.isFinite(dt) || dt <= 0) {
    return baseContact;
  }

  const normal = baseContact.normal ?? { x: 0, z: 1 };
  const nLen = Math.hypot(normal.x, normal.z) || 1;
  const nx = cleanZero(normal.x / nLen);
  const nz = cleanZero(normal.z / nLen);
  const tx = nz;
  const tz = -nx;

  const baseBody = baseContact.body;
  const ctx = contactContextMap.get(baseContact);
  const baseHeading = baseBody.heading ?? before?.heading ?? 0;
  const bs = Math.sin(baseHeading);
  const bc = Math.cos(baseHeading);
  const baseSlide = getContactSlide(baseBody);
  const baseVx = ctx
    ? ctx.baseVelocity.x
    : bs * (baseBody.speed ?? 0) + bc * baseSlide;
  const baseVz = ctx
    ? ctx.baseVelocity.z
    : bc * (baseBody.speed ?? 0) - bs * baseSlide;
  const remainingDt = ctx
    ? ctx.remainingDt
    : dt * (1 - clamp(baseContact.contactFraction ?? 0, 0, 1));
  const incomingSpeed = ctx
    ? ctx.incomingSpeed
    : Math.max(
        Math.hypot(baseVx, baseVz),
        Math.hypot(
          Math.sin(before?.heading ?? 0) * (before?.speed ?? 0) +
            Math.cos(before?.heading ?? 0) * getContactSlide(before),
          Math.cos(before?.heading ?? 0) * (before?.speed ?? 0) -
            Math.sin(before?.heading ?? 0) * getContactSlide(before),
        ),
      );

  let touchBody = ctx?.touchBody ?? null;
  if (!touchBody) {
    const candidateTouch = {
      ...baseBody,
      x: baseBody.x - baseVx * remainingDt,
      z: baseBody.z - baseVz * remainingDt,
    };
    touchBody = overlaps(candidateTouch, obstacle) ? baseBody : candidateTouch;
  }

  const obsHeading = obstacle?.heading ?? 0;
  const obsSpeed = Number.isFinite(obstacle?.speed) ? obstacle.speed : 0;
  const obsSlide = getContactSlide(obstacle);
  const obsVx = Number.isFinite(obstacle?.vx)
    ? obstacle.vx
    : Math.sin(obsHeading) * obsSpeed + Math.cos(obsHeading) * obsSlide;
  const obsVz = Number.isFinite(obstacle?.vz)
    ? obstacle.vz
    : Math.cos(obsHeading) * obsSpeed - Math.sin(obsHeading) * obsSlide;
  const obsVt = obsVx * tx + obsVz * tz;

  const vt = baseVx * tx + baseVz * tz;
  const vnBase = baseVx * nx + baseVz * nz;
  const vtRel = vt - obsVt;
  const absVtRel = Math.abs(vtRel);
  const closingSpeedMps = Math.max(0, baseContact.closingSpeedMps ?? 0);

  const initialPatch = resolveHullContactPatch(touchBody, obstacle, { x: nx, z: nz });
  const halfLength = (touchBody.length ?? PLAYER_VEHICLE.lengthM) / 2;
  const halfWidth = (touchBody.width ?? PLAYER_VEHICLE.widthM) / 2;
  const nFwd = nx * bs + nz * bc;
  const nRight = nx * bc - nz * bs;

  // Normal reaction (-nRight, -nFwd) at lever arm (lateralOffsetM, forwardOffsetM):
  // tau_yaw = r_fwd * F_right - r_right * F_fwd = r_right * n_fwd - r_fwd * n_right
  const rawTorque = initialPatch.lateralOffsetM * nFwd - initialPatch.forwardOffsetM * nRight;
  const yawTorqueNorm =
    Math.abs(rawTorque) < 1e-4
      ? 0
      : clamp(rawTorque / Math.max(0.5, halfLength * 0.82), -1, 1);

  const intensity = clamp(
    (absVtRel / 11) * 0.72 + (closingSpeedMps / 8) * 0.48,
    0.06,
    1.0,
  );

  const outNx = cleanZero(-nx);
  const outNz = cleanZero(-nz);
  const isVehicleObstacle =
    obstacle.type === "vehicle" || obstacle.kind === "parked-vehicle";
  const egoMassKg =
    Number.isFinite(before?.spec?.massKg) && before.spec.massKg > 0
      ? before.spec.massKg
      : playerVehicleDimensions(before).massKg;
  const contactMech = resolveObstacleContactMechanics(
    egoMassKg,
    obstacle,
    closingSpeedMps,
    true,
    dt,
  );
  const obsMomentumShare = contactMech.obsMomentumShare;
  const sharedNormalImpulseNs = Number.isFinite(baseContact.sharedNormalImpulseNs)
    ? baseContact.sharedNormalImpulseNs
    : contactMech.egoNormalImpulseNs;
  const actorNetNormalImpulseNs = Number.isFinite(baseContact.actorNetNormalImpulseNs)
    ? baseContact.actorNetNormalImpulseNs
    : contactMech.actorNetNormalImpulseNs;
  let sharedShearImpulseNs = 0;
  let actorNetShearImpulseNs = 0;
  let responseBody = baseBody;
  if (absVtRel >= 0.05) {
    const mu = isVehicleObstacle ? 0.42 : 0.48;
    const frictionDv = Math.min(
      absVtRel * 0.46,
      mu * (closingSpeedMps * 0.8 + 3.4) * dt,
    );
    let appliedDv;
    if (contactMech.isParkedVehicle && contactMech.stictionBroken) {
      const shearGroundHold = Math.min(frictionDv * 0.35, PARKED_GROUND_MU * 9.81 * dt * 2.0);
      const freeShearDv = Math.max(0, frictionDv - shearGroundHold) * obsMomentumShare;
      appliedDv = shearGroundHold + freeShearDv;
      sharedShearImpulseNs = egoMassKg * appliedDv;
      actorNetShearImpulseNs = egoMassKg * freeShearDv;
    } else if (obsMomentumShare > 0) {
      appliedDv = frictionDv * obsMomentumShare;
      sharedShearImpulseNs = egoMassKg * appliedDv;
      actorNetShearImpulseNs = sharedShearImpulseNs;
    } else {
      appliedDv = frictionDv;
      sharedShearImpulseNs = egoMassKg * appliedDv;
      actorNetShearImpulseNs = 0;
    }
    const fasterCoMoving =
      obsMomentumShare > 0 && obsVt * vt >= 0 && Math.abs(obsVt) > Math.abs(vt);
    const vtNext = vt - Math.sign(vtRel) * appliedDv;
    let velX = vnBase * nx + vtNext * tx;
    let velZ = vnBase * nz + vtNext * tz;
    const maxVt = fasterCoMoving
      ? vt - Math.sign(vtRel) * absVtRel * obsMomentumShare
      : vt;
    const maxAllowedSpeed = fasterCoMoving
      ? Math.max(
          incomingSpeed,
          Math.hypot(vnBase * nx + maxVt * tx, vnBase * nz + maxVt * tz),
        )
      : incomingSpeed;
    const outgoingSpeed = Math.hypot(velX, velZ);
    if (outgoingSpeed > maxAllowedSpeed && outgoingSpeed > 0) {
      const scale = maxAllowedSpeed / outgoingSpeed;
      velX *= scale;
      velZ *= scale;
    }

    const slid = {
      ...touchBody,
      x: touchBody.x + velX * remainingDt,
      z: touchBody.z + velZ * remainingDt,
    };
    let accepted = overlaps(slid, obstacle) ? touchBody : slid;

    let maxYawMag = 0.85 * intensity * dt;
    if (Math.abs(nRight) > Math.abs(nFwd)) {
      const angleToParallel = Math.abs(Math.atan2(nFwd, Math.abs(nRight)));
      // Leave a slight grazing approach angle so multi-step sideswipes stay pressed against the flank
      maxYawMag = Math.min(maxYawMag, Math.max(0, angleToParallel * 0.45));
    }
    const desiredYawDelta = clamp(yawTorqueNorm * maxYawMag, -0.85 * dt, 0.85 * dt);
    if (Math.abs(desiredYawDelta) > 1e-6) {
      const patchAtSlid = resolveHullContactPatch(accepted, obstacle, { x: nx, z: nz });
      for (const frac of [1, 0.5, 0.25]) {
        const dYaw = desiredYawDelta * frac;
        const nextH = baseHeading + dYaw;
        const ns = Math.sin(nextH);
        const nc = Math.cos(nextH);
        // Pivot around the hull contact patch so the scraping corner stays flush (< 2 mm) without floating away
        let pivX = patchAtSlid.worldX - (patchAtSlid.lateralOffsetM * nc + patchAtSlid.forwardOffsetM * ns);
        let pivZ = patchAtSlid.worldZ - (-patchAtSlid.lateralOffsetM * ns + patchAtSlid.forwardOffsetM * nc);
        let rotated = { ...accepted, x: pivX, z: pivZ, heading: nextH };
        if (overlaps(rotated, obstacle)) {
          // Binary push out up to 4 mm along outward normal (away from obstacle!) if pivot slightly grazes inside
          let lo = 0, hi = 0.004;
          if (!overlaps({ ...rotated, x: pivX + outNx * hi, z: pivZ + outNz * hi }, obstacle)) {
            for (let b = 0; b < 8; b++) {
              const mid = 0.5 * (lo + hi);
              if (overlaps({ ...rotated, x: pivX + outNx * mid, z: pivZ + outNz * mid }, obstacle)) lo = mid;
              else hi = mid;
            }
            rotated = { ...rotated, x: pivX + outNx * hi, z: pivZ + outNz * hi };
          }
        }
        if (!overlaps(rotated, obstacle)) {
          accepted = rotated;
          break;
        }
      }
    }

    const fs = Math.sin(accepted.heading);
    const fc = Math.cos(accepted.heading);
    const nextSpeed = cleanZero(velX * fs + velZ * fc);
    const nextSlide = cleanZero(velX * fc - velZ * fs);
    responseBody = {
      ...accepted,
      speed: nextSpeed,
      reason: "vehicle-contact",
      blockedBy: obstacle.id,
    };
    setContactSlide(responseBody, nextSlide);
  } else {
    responseBody = copyContactSlide(baseBody, { ...baseBody });
  }

  const finalPatch =
    responseBody === baseBody
      ? resolveHullContactPatch(baseBody, obstacle, { x: nx, z: nz })
      : resolveHullContactPatch(responseBody, obstacle, { x: nx, z: nz });

  const active = absVtRel >= 0.25 || closingSpeedMps >= 0.6;
  const kind = isVehicleObstacle
    ? "vehicle"
    : obstacle.kind === "barrier"
      ? "barrier"
      : "wall";
  const latNorm = clamp(finalPatch.lateralOffsetM / Math.max(0.4, halfWidth), -1, 1);
  const fwdNorm = clamp(finalPatch.forwardOffsetM / Math.max(0.5, halfLength), -1, 1);
  const frontWeight = fwdNorm > -0.15 ? clamp(0.45 + 0.55 * Math.max(0, fwdNorm), 0, 1) : 0.2;

  const steerKickRad = active && Math.abs(yawTorqueNorm) > 0.02
    ? cleanZero(clamp(yawTorqueNorm * 0.095 * intensity * frontWeight, -0.11, 0.11))
    : 0;
  const rollImpulse = active && (Math.abs(nRight) > 0.02 || Math.abs(latNorm) > 0.05)
    ? cleanZero(clamp((-nRight * 0.28 + latNorm * 0.08) * intensity, -0.45, 0.45))
    : 0;
  const pitchImpulse = active && Math.abs(nFwd) > 0.02
    ? cleanZero(clamp(nFwd * 0.22 * intensity, -0.35, 0.35))
    : 0;

  const slipSign = absVtRel >= 0.05 ? Math.sign(vtRel) : 0;
  const sharedImpulse = {
    ix: cleanZero(nx * actorNetNormalImpulseNs + slipSign * tx * actorNetShearImpulseNs),
    iz: cleanZero(nz * actorNetNormalImpulseNs + slipSign * tz * actorNetShearImpulseNs),
    egoIx: cleanZero(-nx * sharedNormalImpulseNs - slipSign * tx * sharedShearImpulseNs),
    egoIz: cleanZero(-nz * sharedNormalImpulseNs - slipSign * tz * sharedShearImpulseNs),
    normalImpulseNs: cleanZero(sharedNormalImpulseNs),
    actorNetNormalImpulseNs: cleanZero(actorNetNormalImpulseNs),
    shearImpulseNs: cleanZero(sharedShearImpulseNs),
    actorNetShearImpulseNs: cleanZero(actorNetShearImpulseNs),
    stictionBroken: contactMech.stictionBroken,
  };

  return {
    ...baseContact,
    body: responseBody,
    sharedImpulse,
    scraping: {
      active,
      kind,
      wheel: finalPatch.wheel,
      side: baseContact.side,
      intensity: cleanZero(intensity),
      tangentialSpeedMps: cleanZero(absVtRel),
      tangentialSlipSignedMps: cleanZero(vtRel),
      closingSpeedMps: cleanZero(closingSpeedMps),
      worldX: finalPatch.worldX,
      worldZ: finalPatch.worldZ,
      normalX: outNx,
      normalZ: outNz,
      steerKickRad,
      rollImpulse,
      pitchImpulse,
    },
  };
}

function stepUnderdampedSpring(pos, vel, omega, zeta, limit, dt) {
  const wd = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const decay = Math.exp(-zeta * omega * dt);
  const cos = Math.cos(wd * dt);
  const sin = Math.sin(wd * dt);
  const bCoeff = (vel + zeta * omega * pos) / wd;
  let nextPos = decay * (pos * cos + bCoeff * sin);
  let nextVel = decay * (
    (bCoeff * wd - zeta * omega * pos) * cos -
    (pos * wd + zeta * omega * bCoeff) * sin
  );
  if (Math.abs(nextPos) > limit) {
    nextPos = clamp(nextPos, -limit, limit);
    if (nextPos * nextVel > 0) nextVel *= 0.25;
  }
  if (Math.abs(nextPos) < 2e-4 && Math.abs(nextVel) < 2e-3) {
    nextPos = 0;
    nextVel = 0;
  }
  return { pos: cleanZero(nextPos), vel: cleanZero(nextVel) };
}

export function recordActorImpactReaction(
  actor,
  {
    normalX = 0,
    normalZ = 1,
    closingSpeedMps = 0,
    tangentialSpeedMps = 0,
    tangentialDirX = null,
    tangentialDirZ = null,
    sharedImpulse = null,
    contactX = null,
    contactZ = null,
    egoMassKg = PLAYER_VEHICLE.massKg,
    tick = 0,
  } = {},
) {
  if (!actor || typeof actor !== "object" || actor.type === "pedestrian") {
    return INACTIVE_ACTOR_REACTION;
  }

  const nLen = Math.hypot(normalX, normalZ) || 1;
  const nx = normalX / nLen;
  const nz = normalZ / nLen;
  const closing = Math.max(0, Number.isFinite(closingSpeedMps) ? closingSpeedMps : 0);
  const tangential = Math.max(
    0,
    Number.isFinite(tangentialSpeedMps) ? Math.abs(tangentialSpeedMps) : 0,
  );
  if (closing < 0.05 && tangential < 0.2 && !sharedImpulse) {
    return getActorImpactReaction(actor);
  }

  const mEgo = Number.isFinite(egoMassKg) && egoMassKg > 0 ? egoMassKg : PLAYER_VEHICLE.massKg;
  const mActor = resolveVehicleBodyMassKg(actor);
  const reducedMass = (mEgo * mActor) / (mEgo + mActor);

  const ah = Number.isFinite(actor.heading) ? actor.heading : 0;
  const as = Math.sin(ah);
  const ac = Math.cos(ah);
  const pushForward = nx * as + nz * ac;
  const pushRight = nx * ac - nz * as;
  const defaultTangSign = (nz * as - nx * ac) * (pushForward >= 0 ? 1 : -1) >= 0 ? 1 : -1;
  const tDirX = Number.isFinite(tangentialDirX) ? tangentialDirX : nz * defaultTangSign;
  const tDirZ = Number.isFinite(tangentialDirZ) ? tangentialDirZ : -nx * defaultTangSign;
  const shearForward = tDirX * as + tDirZ * ac;
  const shearRight = tDirX * ac - tDirZ * as;

  const isParkedActor = actor.kind === "parked-vehicle";
  const brokeStiction = sharedImpulse && typeof sharedImpulse.stictionBroken === "boolean"
    ? sharedImpulse.stictionBroken
    : (!isParkedActor || closing >= PARKED_BREAKAWAY_MPS);

  // Suspension body rocking feels the contact force even when locked parked tires hold stiction,
  // whereas chassis translation (lateralPushMps / longitudinalPushMps) ONLY occurs when stiction breaks!
  const fallbackNormalImpulseNs = reducedMass * closing;
  const fallbackShearImpulseNs =
    0.34 * reducedMass * Math.min(tangential * 0.45, closing * 0.8 + 1.8);
  const bodyNormalImpulseNs = sharedImpulse && Number.isFinite(sharedImpulse.normalImpulseNs)
    ? sharedImpulse.normalImpulseNs
    : fallbackNormalImpulseNs;
  const bodyShearImpulseNs = sharedImpulse && Number.isFinite(sharedImpulse.shearImpulseNs)
    ? sharedImpulse.shearImpulseNs
    : fallbackShearImpulseNs;
  const rockLatDv = pushRight * (bodyNormalImpulseNs / mActor) + shearRight * (bodyShearImpulseNs / mActor) * 0.45;
  const rockLongDv = pushForward * (bodyNormalImpulseNs / mActor) + shearForward * (bodyShearImpulseNs / mActor) * 0.72;
  const rockTotalDv = Math.hypot(rockLatDv, rockLongDv);

  let transLongDv = 0;
  let transLatDv = 0;
  let transTotalDv = 0;
  if (brokeStiction) {
    if (sharedImpulse && Number.isFinite(sharedImpulse.ix) && Number.isFinite(sharedImpulse.iz)) {
      const dvX = sharedImpulse.ix / mActor;
      const dvZ = sharedImpulse.iz / mActor;
      transLongDv = dvX * as + dvZ * ac;
      transLatDv = dvX * ac - dvZ * as;
      transTotalDv = Math.hypot(dvX, dvZ);
    } else {
      transLatDv = rockLatDv;
      transLongDv = rockLongDv;
      transTotalDv = rockTotalDv;
    }
  }

  let leverTorqueNorm = pushRight * shearForward - pushForward * pushRight * 0.35;
  if (Number.isFinite(contactX) && Number.isFinite(contactZ) && Number.isFinite(actor.x) && Number.isFinite(actor.z)) {
    const rFwd = (contactX - actor.x) * as + (contactZ - actor.z) * ac;
    const rRight = (contactX - actor.x) * ac - (contactZ - actor.z) * as;
    const halfLen = Math.max(1.2, (actor.length ?? 4.2) * 0.45);
    leverTorqueNorm = clamp((rFwd * pushRight - rRight * pushForward) / halfLen, -1.25, 1.25);
  }

  let state = actorImpactReactions.get(actor);
  if (!state) {
    state = {
      rollRad: 0,
      rollVel: 0,
      pitchRad: 0,
      pitchVel: 0,
      heaveM: 0,
      heaveVel: 0,
      lateralPushMps: 0,
      longitudinalPushMps: 0,
      pendingLongDvMps: 0,
      yawPushRadS: 0,
      stictionBroken: false,
      lastTick: -1,
    };
    actorImpactReactions.set(actor, state);
  }
  if (brokeStiction) {
    state.stictionBroken = true;
  }

  const sameTickScale = state.lastTick === tick && tick > 0 ? 0.35 : 1.0;

  state.rollVel = clamp(
    state.rollVel + rockLatDv * 0.58 * sameTickScale,
    -1.85,
    1.85,
  );
  state.pitchVel = clamp(
    state.pitchVel - rockLongDv * 0.42 * sameTickScale,
    -1.35,
    1.35,
  );
  state.heaveVel = clamp(
    state.heaveVel - rockTotalDv * 0.085 * sameTickScale,
    -0.42,
    0.42,
  );
  if (brokeStiction) {
    state.lateralPushMps = clamp(
      state.lateralPushMps + transLatDv * sameTickScale,
      -4.5,
      4.5,
    );
    state.longitudinalPushMps = clamp(
      state.longitudinalPushMps + transLongDv * sameTickScale,
      -4.5,
      4.5,
    );
    state.pendingLongDvMps += transLongDv * sameTickScale;
    state.yawPushRadS = clamp(
      state.yawPushRadS + leverTorqueNorm * transTotalDv * 0.65 * sameTickScale,
      -2.4,
      2.4,
    );
  }
  state.lastTick = tick;

  return getActorImpactReaction(actor);
}

export function stepActorImpactReaction(actor, dt = STEP) {
  if (!actor || typeof actor !== "object") return INACTIVE_ACTOR_REACTION;
  const state = actorImpactReactions.get(actor);
  if (!state) return INACTIVE_ACTOR_REACTION;
  if (!Number.isFinite(dt) || dt <= 0) return getActorImpactReaction(actor);

  const omega = 11;
  const zeta = 0.28;
  const roll = stepUnderdampedSpring(state.rollRad, state.rollVel, omega, zeta, 0.11, dt);
  const pitch = stepUnderdampedSpring(state.pitchRad, state.pitchVel, omega, zeta, 0.08, dt);
  const heave = stepUnderdampedSpring(state.heaveM, state.heaveVel, 13, 0.34, 0.035, dt);

  const isParkedActor = actor.kind === "parked-vehicle";
  let lateralPushMps;
  let longitudinalPushMps;
  let yawPushRadS;
  if (isParkedActor) {
    // Explicit Coulomb locked-tire ground friction deceleration (a = mu_ground * g = 7.06 m/s^2)!
    const speedPush = Math.hypot(state.lateralPushMps, state.longitudinalPushMps ?? 0);
    const decel = PARKED_GROUND_MU * 9.81 * dt;
    const ratio = speedPush > decel && speedPush > 1e-6 ? (speedPush - decel) / speedPush : 0;
    lateralPushMps = Math.abs(state.lateralPushMps * ratio) < 5e-4 ? 0 : cleanZero(state.lateralPushMps * ratio);
    longitudinalPushMps = Math.abs((state.longitudinalPushMps ?? 0) * ratio) < 5e-4 ? 0 : cleanZero((state.longitudinalPushMps ?? 0) * ratio);
    const yawDecel = 4.2 * dt;
    const absYaw = Math.abs(state.yawPushRadS);
    yawPushRadS = absYaw > yawDecel ? cleanZero(Math.sign(state.yawPushRadS) * (absYaw - yawDecel)) : 0;
  } else {
    const pushDecay = Math.exp(-5.5 * dt);
    lateralPushMps =
      Math.abs(state.lateralPushMps * pushDecay) < 5e-4
        ? 0
        : cleanZero(state.lateralPushMps * pushDecay);
    longitudinalPushMps =
      Math.abs((state.longitudinalPushMps ?? 0) * pushDecay) < 5e-4
        ? 0
        : cleanZero((state.longitudinalPushMps ?? 0) * pushDecay);
    yawPushRadS =
      Math.abs(state.yawPushRadS * pushDecay) < 5e-4
        ? 0
        : cleanZero(state.yawPushRadS * pushDecay);
  }

  state.rollRad = roll.pos;
  state.rollVel = roll.vel;
  state.pitchRad = pitch.pos;
  state.pitchVel = pitch.vel;
  state.heaveM = heave.pos;
  state.heaveVel = heave.vel;
  state.lateralPushMps = lateralPushMps;
  state.longitudinalPushMps = longitudinalPushMps;
  state.yawPushRadS = yawPushRadS;

  if (
    roll.pos === 0 &&
    roll.vel === 0 &&
    pitch.pos === 0 &&
    pitch.vel === 0 &&
    heave.pos === 0 &&
    heave.vel === 0 &&
    lateralPushMps === 0 &&
    longitudinalPushMps === 0 &&
    yawPushRadS === 0
  ) {
    actorImpactReactions.delete(actor);
    return INACTIVE_ACTOR_REACTION;
  }

  return getActorImpactReaction(actor);
}

export function consumeActorPendingLongDv(actor) {
  const state = actor ? actorImpactReactions.get(actor) : null;
  if (!state || !state.pendingLongDvMps) return 0;
  const dv = state.pendingLongDvMps;
  state.pendingLongDvMps = 0;
  return cleanZero(dv);
}

export function getActorImpactReaction(actor) {
  if (!actor || typeof actor !== "object") return INACTIVE_ACTOR_REACTION;
  const state = actorImpactReactions.get(actor);
  if (!state) return INACTIVE_ACTOR_REACTION;
  const active =
    Math.abs(state.rollRad) > 1e-6 ||
    Math.abs(state.rollVel) > 1e-5 ||
    Math.abs(state.pitchRad) > 1e-6 ||
    Math.abs(state.pitchVel) > 1e-5 ||
    Math.abs(state.heaveM) > 1e-6 ||
    Math.abs(state.lateralPushMps) > 1e-5 ||
    Math.abs(state.longitudinalPushMps ?? 0) > 1e-5 ||
    Math.abs(state.yawPushRadS) > 1e-5;
  return {
    active,
    rollRad: cleanZero(state.rollRad),
    pitchRad: cleanZero(state.pitchRad),
    heaveM: cleanZero(state.heaveM),
    lateralPushMps: cleanZero(state.lateralPushMps),
    longitudinalPushMps: cleanZero(state.longitudinalPushMps ?? 0),
    yawPushRadS: cleanZero(state.yawPushRadS),
    stictionBroken: Boolean(state.stictionBroken),
  };
}

export function createDefaultWheelInteractionState() {
  return {
    surfaceKind: "asphalt",
    tireSmokeIntensity: 0,
    scrapeSmokeIntensity: 0,
    steerKickRad: 0,
    lateralAccelMps2: 0,
    longitudinalAccelMps2: 0,
    maxSlipAngleRad: 0,
    wheels: {
      frontLeft: {
        slipAngleRad: 0,
        brakeLockSlip: 0,
        driveWheelSpin: 0,
        scrubIntensity: 0,
        surfaceKind: "asphalt",
      },
      frontRight: {
        slipAngleRad: 0,
        brakeLockSlip: 0,
        driveWheelSpin: 0,
        scrubIntensity: 0,
        surfaceKind: "asphalt",
      },
      rearLeft: {
        slipAngleRad: 0,
        brakeLockSlip: 0,
        driveWheelSpin: 0,
        scrubIntensity: 0,
        surfaceKind: "asphalt",
      },
      rearRight: {
        slipAngleRad: 0,
        brakeLockSlip: 0,
        driveWheelSpin: 0,
        scrubIntensity: 0,
        surfaceKind: "asphalt",
      },
    },
    scraping: {
      active: false,
      kind: "none",
      wheel: null,
      side: null,
      grazing: false,
      intensity: 0,
      tangentialSpeedMps: 0,
      closingSpeedMps: 0,
      attackAngleRad: 0,
      worldX: 0,
      worldZ: 0,
      normalX: 0,
      normalZ: 0,
      steerKickRad: 0,
      rollImpulse: 0,
      pitchImpulse: 0,
      heaveImpulse: 0,
    },
  };
}

export function cloneWheelInteractionState(interaction) {
  if (!interaction || typeof interaction !== "object") {
    return createDefaultWheelInteractionState();
  }
  const fresh = createDefaultWheelInteractionState();
  fresh.surfaceKind = interaction.surfaceKind ?? "asphalt";
  fresh.tireSmokeIntensity = cleanZero(interaction.tireSmokeIntensity ?? 0);
  fresh.scrapeSmokeIntensity = cleanZero(interaction.scrapeSmokeIntensity ?? 0);
  fresh.steerKickRad = cleanZero(interaction.steerKickRad ?? 0);
  fresh.lateralAccelMps2 = cleanZero(interaction.lateralAccelMps2 ?? 0);
  fresh.longitudinalAccelMps2 = cleanZero(interaction.longitudinalAccelMps2 ?? 0);
  fresh.maxSlipAngleRad = cleanZero(interaction.maxSlipAngleRad ?? 0);
  if (interaction.wheels && typeof interaction.wheels === "object") {
    for (let i = 0; i < WHEEL_NAMES.length; i++) {
      const name = WHEEL_NAMES[i];
      const w = interaction.wheels[name];
      if (w && typeof w === "object") {
        fresh.wheels[name] = {
          slipAngleRad: cleanZero(w.slipAngleRad ?? 0),
          brakeLockSlip: cleanZero(w.brakeLockSlip ?? 0),
          driveWheelSpin: cleanZero(w.driveWheelSpin ?? 0),
          scrubIntensity: cleanZero(w.scrubIntensity ?? 0),
          surfaceKind: w.surfaceKind ?? fresh.surfaceKind,
        };
      }
    }
  }
  if (interaction.scraping && typeof interaction.scraping === "object") {
    const s = interaction.scraping;
    fresh.scraping = {
      active: Boolean(s.active),
      kind: s.kind ?? "none",
      wheel: s.wheel ?? null,
      side: s.side ?? null,
      grazing: Boolean(s.grazing),
      intensity: cleanZero(s.intensity ?? 0),
      tangentialSpeedMps: cleanZero(s.tangentialSpeedMps ?? 0),
      closingSpeedMps: cleanZero(s.closingSpeedMps ?? 0),
      attackAngleRad: cleanZero(s.attackAngleRad ?? 0),
      worldX: cleanZero(s.worldX ?? 0),
      worldZ: cleanZero(s.worldZ ?? 0),
      normalX: cleanZero(s.normalX ?? 0),
      normalZ: cleanZero(s.normalZ ?? 0),
      steerKickRad: cleanZero(s.steerKickRad ?? 0),
      rollImpulse: cleanZero(s.rollImpulse ?? 0),
      pitchImpulse: cleanZero(s.pitchImpulse ?? 0),
      heaveImpulse: cleanZero(s.heaveImpulse ?? 0),
    };
  }
  return fresh;
}

export function computeWheelInteractionState(
  before,
  after,
  command,
  suspension,
  wheelLoadsN,
  {
    surface = null,
    contact = null,
    curbScrub = null,
    scraping = null,
    driverCommand = null,
    dt = STEP,
  } = {},
) {
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : STEP;
  const surfaceKind =
    surface && typeof surface === "object"
      ? (surface.surfaceKind ?? surface.kind ?? "asphalt")
      : "asphalt";
  const gripMult =
    surface && typeof surface === "object" && Number.isFinite(surface.gripMultiplier)
      ? clamp(surface.gripMultiplier, 0.3, 1.2)
      : 1;

  const oldSpeed = Number.isFinite(before?.speed) ? before.speed : 0;
  const newSpeed = Number.isFinite(after?.speed) ? after.speed : 0;
  const avgSpeed = (oldSpeed + newSpeed) * 0.5;
  const absSpeed = Math.abs(avgSpeed);
  const maxAbsSpeed = Math.max(Math.abs(oldSpeed), Math.abs(newSpeed));

  const rawScrape =
    contact?.scraping ?? scraping ?? (curbScrub?.active ? curbScrub : null);
  const scrapeActive = Boolean(rawScrape?.active);

  const yaw = angleDelta(after?.heading ?? 0, before?.heading ?? 0);
  const dimensions = playerVehicleDimensions(before);
  const yawRate = yaw / safeDt;
  const lateralAccel = avgSpeed * yawRate;
  // Exclude collision/scrape heading pivot and post-impact suspension yaw rebound from steered tire cornering slip
  const hasContactRebound =
    Boolean(contact) ||
    scrapeActive ||
    Boolean(before?.vehicle?.interaction?.scraping?.active) ||
    Boolean(suspension?.active);
  const steeredLatAccel = hasContactRebound
    ? (avgSpeed * avgSpeed * Math.tan(clamp(after?.steer ?? 0, -0.7, 0.7))) / Math.max(1.5, dimensions.wheelbaseM)
    : lateralAccel;
  const signedAccel = (newSpeed - oldSpeed) / safeDt;
  const decel = !contact
    ? Math.max(0, (Math.abs(oldSpeed) - Math.abs(newSpeed)) / safeDt)
    : 0;
  const accelMag = !contact
    ? Math.max(0, (Math.abs(newSpeed) - Math.abs(oldSpeed)) / safeDt)
    : 0;

  const effectiveCmd = driverCommand ?? command;
  const requested = Number.isFinite(effectiveCmd?.targetSpeed) ? effectiveCmd.targetSpeed : 0;
  const reversing = oldSpeed * requested < 0;
  const driverHoldingForwardThrottle = Boolean(
    driverCommand && requested > 0.15 && oldSpeed >= -0.05 && !reversing,
  );
  const slowing = !driverHoldingForwardThrottle && (Math.abs(requested) < Math.abs(oldSpeed) - 1e-6 || reversing);
  const brake = Number.isFinite(effectiveCmd?.brake)
    ? clamp(effectiveCmd.brake, 0, 1)
    : !contact && !effectiveCmd?.coasting && slowing && Math.abs(oldSpeed) > 0.2
      ? clamp(Math.max(0.6, decel / 6.5), 0, 1)
      : 0;

  const chaseSlipRad =
    (Number.isFinite(after?.chaseSlipRad) ? after.chaseSlipRad : 0) +
    (Number.isFinite(after?.arcadeSlip) ? after.arcadeSlip : 0);

  const wheels = {};
  let maxSlipAngleRad = 0;

  for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
    const [name, sideSign, axleSign] = WHEEL_LAYOUT[i];
    const restLoadN = staticVehicleWheelLoadN(dimensions, axleSign > 0);
    const loadN =
      wheelLoadsN && Number.isFinite(wheelLoadsN[name])
        ? wheelLoadsN[name]
        : restLoadN;
    const unloadRatio = clamp(restLoadN / Math.max(400, loadN), 0.65, 1.55);

    const dynamicCornerSlip =
      maxAbsSpeed > 0.8
        ? clamp(
            -(steeredLatAccel / (8.0 * gripMult)) *
              0.085 *
              (axleSign > 0 ? 1.06 : 0.96) *
              unloadRatio +
              chaseSlipRad,
            -0.45,
            0.45,
          )
        : 0;
    const absWheelSlip = Math.abs(dynamicCornerSlip);
    if (absWheelSlip > maxSlipAngleRad) maxSlipAngleRad = absWheelSlip;

    const brakeLockSlip =
      brake > 0.05 && absSpeed > 0.5 && decel > 0.8
        ? clamp(
            (decel / Math.max(2.4, 7.2 * gripMult) - 0.32) *
              1.18 *
              brake *
              unloadRatio,
            0,
            1,
          )
        : 0;

    const driveWheelSpin =
      !contact && accelMag > 0.4
        ? clamp(
            (accelMag / Math.max(1.6, 3.1 * gripMult) - 0.42) *
              0.92 *
              unloadRatio,
            0,
            1,
          )
        : 0;

    let scrubIntensity = 0;
    if (scrapeActive) {
      const baseInt = clamp(rawScrape.intensity ?? 0, 0, 1);
      if (rawScrape.wheel === name) {
        scrubIntensity = baseInt;
      } else if (
        (rawScrape.side === "left" && sideSign < 0) ||
        (rawScrape.side === "right" && sideSign > 0)
      ) {
        scrubIntensity = baseInt * (rawScrape.kind === "curb" ? 0.35 : 0.6);
      }
    }

    wheels[name] = {
      slipAngleRad: round4(dynamicCornerSlip),
      brakeLockSlip: round4(brakeLockSlip),
      driveWheelSpin: round4(driveWheelSpin),
      scrubIntensity: round4(scrubIntensity),
      surfaceKind,
    };
  }

  let tireSmokeIntensity = 0;
  let scrapeSmokeIntensity = 0;
  const suppressDrySmoke = surfaceKind === "water" || surfaceKind === "sand";
  if (!suppressDrySmoke) {
    let cornerSmoke = 0;
    if (!contact && !scrapeActive) {
      const absLat = Math.abs(steeredLatAccel);
      const absSlip = hasContactRebound ? 0 : Math.abs(chaseSlipRad);
      if (maxAbsSpeed > 1.5 && (absLat > 4.6 || absSlip > 0.085)) {
        const latFactor = absLat > 4.6 ? clamp((absLat - 4.6) / 3.4, 0, 1) : 0;
        const slipFactor = absSlip > 0.085 ? clamp((absSlip - 0.085) / 0.065, 0, 1) : 0;
        cornerSmoke = 0.25 + 0.75 * Math.max(latFactor, slipFactor);
      }
    }

    let brakeSmoke = 0;
    if (surfaceKind === "asphalt" || surfaceKind === "cobble") {
      if (brake > 0.5 && absSpeed > 7.5 && decel > 5.8) {
        const decelFactor = clamp(
          (decel - 5.8) / 2.0 + ((absSpeed - 7.5) / 18) * 0.45,
          0,
          1,
        );
        brakeSmoke = clamp(0.2 + 0.55 * decelFactor, 0.2, 0.75);
      }
    }

    if (scrapeActive && (rawScrape.tangentialSpeedMps ?? 0) > 2.2) {
      const tangFactor = clamp(
        ((rawScrape.tangentialSpeedMps - 2.2) / 9.5) * 0.7 +
          (rawScrape.intensity ?? 0) * 0.3,
        0,
        1,
      );
      scrapeSmokeIntensity = clamp(0.35 + 0.60 * tangFactor, 0.35, 0.95);
    }

    tireSmokeIntensity = clamp(Math.max(cornerSmoke, brakeSmoke), 0, 1);
  }

  const scrapingSummary = scrapeActive
    ? {
        active: true,
        kind: rawScrape.kind ?? "wall",
        wheel: rawScrape.wheel ?? null,
        side: rawScrape.side ?? null,
        grazing: Boolean(rawScrape.grazing),
        intensity: round4(rawScrape.intensity ?? 0),
        tangentialSpeedMps: round4(rawScrape.tangentialSpeedMps ?? 0),
        closingSpeedMps: round4(rawScrape.closingSpeedMps ?? 0),
        attackAngleRad: round4(rawScrape.attackAngleRad ?? 0),
        worldX: round4(rawScrape.worldX ?? after?.x ?? 0),
        worldZ: round4(rawScrape.worldZ ?? after?.z ?? 0),
        normalX: round4(rawScrape.normalX ?? 0),
        normalZ: round4(rawScrape.normalZ ?? 0),
        steerKickRad: round4(rawScrape.steerKickRad ?? 0),
        rollImpulse: round4(rawScrape.rollImpulse ?? 0),
        pitchImpulse: round4(rawScrape.pitchImpulse ?? 0),
        heaveImpulse: round4(rawScrape.heaveImpulse ?? 0),
      }
    : {
        active: false,
        kind: "none",
        wheel: null,
        side: null,
        grazing: false,
        intensity: 0,
        tangentialSpeedMps: 0,
        closingSpeedMps: 0,
        attackAngleRad: 0,
        worldX: 0,
        worldZ: 0,
        normalX: 0,
        normalZ: 0,
        steerKickRad: 0,
        rollImpulse: 0,
        pitchImpulse: 0,
        heaveImpulse: 0,
      };

  const steerKickRad = round4(
    (scrapeActive ? (rawScrape.steerKickRad ?? 0) : 0) +
      (curbScrub?.active && curbScrub !== rawScrape ? (curbScrub.steerKickRad ?? 0) : 0),
  );

  return {
    surfaceKind,
    tireSmokeIntensity: round4(tireSmokeIntensity),
    scrapeSmokeIntensity: round4(scrapeSmokeIntensity),
    steerKickRad,
    lateralAccelMps2: round4(lateralAccel),
    longitudinalAccelMps2: round4(signedAccel),
    maxSlipAngleRad: round4(maxSlipAngleRad),
    wheels,
    scraping: scrapingSummary,
  };
}
