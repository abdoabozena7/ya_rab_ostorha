import { STEP } from "./config.js";
import {
  angleDelta,
  isDiagonalRoad,
  roadFrame,
  roadIntersection,
  roadPoseAt,
  roadProject,
  sweepSafe,
} from "./geometry.js";
import { districtRoadPose } from "./egypt-district.js";
import { planDistrictRoute } from "./district-navigation.js";
import { isDispatchTracked } from "./pursuit-dispatch.js";
import { followPath } from "./vehicle.js";

const MIN_JUNCTION_ANGLE_RAD = 0.35;
const ticks = seconds => Math.max(1, Math.round(seconds / STEP));

function lineAngle(fa, fb) {
  const cross = Math.abs(fa.ux * fb.uz - fa.uz * fb.ux);
  const dot = Math.abs(fa.ux * fb.ux + fa.uz * fb.uz);
  return Math.atan2(cross, dot);
}

function poseOnRoad(road, along, side = 1) {
  if (!isDiagonalRoad(road)) return districtRoadPose(road, along, side);
  if (![-1, 1].includes(side)) throw new RangeError("District road side must be -1 or 1");
  if (road.flow && side !== road.flow)
    throw new RangeError(`Wrong-way pose on ${road.id}`);
  const f = roadFrame(road);
  if (!Number.isFinite(along) || along < f.minAlong || along > f.maxAlong)
    throw new RangeError(`Pose is outside ${road.id}`);
  return roadPoseAt(road, along, road.flow || side);
}

export function onRoad(a, b, pad = 0) {
  const road = typeof a?.axis === "string" ? a : b;
  const body = road === a ? b : a;
  if (!road || !body || typeof road.axis !== "string") return false;
  if (!isDiagonalRoad(road)) {
    const across = road.axis === "x" ? body.z : body.x;
    return Math.abs(across - road.fixed) <= road.width / 2 + pad &&
      body[road.axis] >= road.min - pad && body[road.axis] <= road.max + pad;
  }
  const f = roadFrame(road);
  const { along, absLateral } = roadProject(road, body);
  return absLateral <= road.width / 2 + pad &&
    along >= f.minAlong - pad && along <= f.maxAlong + pad;
}

function isOnRoad(body, road, pad = 0) {
  return onRoad(road, body, pad);
}

function motionVector(body) {
  if (!Number.isFinite(body.heading) && Number.isFinite(body.vx) && Number.isFinite(body.vz)) {
    const mag = Math.hypot(body.vx, body.vz);
    if (mag > 1e-6) return { sin: body.vx / mag, cos: body.vz / mag };
  }
  const effective = (body.speed ?? 0) < 0 ? (body.heading ?? 0) + Math.PI : (body.heading ?? 0);
  return { sin: Math.sin(effective), cos: Math.cos(effective) };
}

export function aheadJunctionTargets(roads, ego, {
  minGap = 7,
  maxGap = 70,
  minWidth = 5,
  minAlign = .86,
  branchOffsetM = 14,
  forwardOffsetM = 12,
} = {}) {
  if (!Array.isArray(roads) || !ego) return [];
  const { sin, cos } = motionVector(ego);
  const incoming = roads.filter(road => !road.supportApron && !road.parkingBay && onRoad(road, ego))
    .map(road => {
      if (!isDiagonalRoad(road)) return { road, align: road.axis === "x" ? sin : cos };
      const f = roadFrame(road);
      return { road, align: f.ux * sin + f.uz * cos };
    })
    .sort((a, b) => Math.abs(b.align) - Math.abs(a.align))[0];
  if (!incoming || Math.abs(incoming.align) < minAlign) return [];
  const { road } = incoming;
  const direction = Math.sign(incoming.align) || 1;
  const rf = roadFrame(road);
  const egoProj = roadProject(road, ego);
  const targets = [];

  for (const crossing of roads) {
    if (crossing === road || crossing.id === road.id || crossing.supportApron ||
        crossing.parkingBay || crossing.width < minWidth) continue;
    const cf = roadFrame(crossing);
    const angle = lineAngle(rf, cf);
    if (angle < MIN_JUNCTION_ANGLE_RAD) continue;
    const endPad = !isDiagonalRoad(road) && !isDiagonalRoad(crossing) ? 0 : 0.5;
    const hit = roadIntersection(road, crossing, endPad);
    if (!hit) continue;
    const gap = (hit.alongA - egoProj.along) * direction;
    if (gap < minGap || gap > maxGap) continue;
    const goals = [];
    for (const sign of crossing.flow ? [crossing.flow] : [1, -1]) {
      const along = hit.alongB + sign * branchOffsetM;
      if (along < cf.minAlong + 3 || along > cf.maxAlong - 3) continue;
      goals.push({ ...poseOnRoad(crossing, along, sign), roadId: crossing.id, sign, kind: "branch" });
    }
    if (!road.flow || road.flow === direction) {
      const forwardAlong = hit.alongA + direction * forwardOffsetM;
      if (forwardAlong >= rf.minAlong + 3 && forwardAlong <= rf.maxAlong - 3) {
        goals.push({
          ...poseOnRoad(road, forwardAlong, direction),
          roadId: road.id,
          sign: direction,
          kind: "continue",
        });
      }
    }
    targets.push({
      id: `${road.id}:${direction}:${crossing.id}`,
      road,
      crossing,
      direction,
      junction: { x: hit.x, z: hit.z },
      alongRoad: hit.alongA,
      alongCrossing: hit.alongB,
      gap,
      angle,
      goals,
    });
  }

  return targets.sort((a, b) => a.gap - b.gap || a.id.localeCompare(b.id));
}

export function selectDispatchJunction(roads, patrol, report) {
  if (!report || Math.abs(report.speed) < 3) return null;
  const { sin, cos } = motionVector(report);
  const incoming = roads.filter(road => !road.supportApron && !road.parkingBay && isOnRoad(report, road))
    .map(road => {
      if (!isDiagonalRoad(road)) return { road, align: road.axis === "x" ? sin : cos };
      const f = roadFrame(road);
      return { road, align: f.ux * sin + f.uz * cos };
    })
    .sort((a, b) => Math.abs(b.align) - Math.abs(a.align))[0];
  if (!incoming || Math.abs(incoming.align) < .86) return null;
  const { road } = incoming, direction = Math.sign(incoming.align), choices = [];
  const roadDiag = isDiagonalRoad(road);
  const rf = roadDiag ? roadFrame(road) : null;
  const egoProj = roadDiag ? roadProject(road, report) : null;

  for (const crossing of roads) {
    if (!roadDiag && !isDiagonalRoad(crossing)) {
      if (crossing.axis === road.axis || crossing.supportApron || crossing.parkingBay || crossing.width < 5 ||
          road.fixed < crossing.min || road.fixed > crossing.max ||
          crossing.fixed < road.min || crossing.fixed > road.max || !isOnRoad(patrol, crossing, .42)) continue;
      const gap = (crossing.fixed - report[road.axis]) * direction;
      const crossGap = road.fixed - patrol[crossing.axis], crossSign = Math.sign(crossGap);
      if (gap < 7 || gap > 70 || Math.abs(crossGap) < 4 || Math.abs(crossGap) > 42 ||
          (crossing.flow && crossing.flow !== crossSign)) continue;
      const heading = districtRoadPose(
        crossing,
        Math.min(crossing.max, Math.max(crossing.min, patrol[crossing.axis])),
        crossSign,
      ).heading;
      if (Math.abs(angleDelta(heading, patrol.heading)) > .42) continue;
      const evidence = Math.abs(report.speed), egoEta = gap / evidence;
      const intercept = patrol.squadRole === "INTERCEPTOR";
      const entryEta = Math.abs(crossGap) / Math.max(5, Math.min(12, Math.abs(patrol.speed) + 4)) +
        (intercept ? 2 : 0);
      if (entryEta > egoEta + (intercept ? 0 : 1.4)) continue;
      if (intercept && road.flow && road.flow !== direction) continue;
      const along = intercept ? crossing.fixed + 12 * direction : road.fixed - crossSign * 2.7;
      const targetRoad = intercept ? road : crossing;
      const targetSign = intercept ? direction : crossSign;
      if (along < targetRoad.min + (patrol.length ?? 0) / 2 || along > targetRoad.max - (patrol.length ?? 0) / 2) continue;
      const goal = { ...districtRoadPose(targetRoad, along, targetSign), roadId: targetRoad.id };
      const junction = road.axis === "x" ? { x: crossing.fixed, z: road.fixed } : { x: road.fixed, z: crossing.fixed };
      choices.push({ id: `${crossing.id}:${targetSign}:${road.id}`, junction, goal, entryEta, egoEta,
        approach: road, direction, role: intercept ? "BLOCK_INTERCEPT" : "FLANK",
        score: Math.abs(egoEta - entryEta) + gap * .015 });
      continue;
    }

    if (crossing === road || crossing.id === road.id || crossing.supportApron || crossing.parkingBay || crossing.width < 5)
      continue;
    const roadFrm = rf ?? roadFrame(road);
    const crossFrm = roadFrame(crossing);
    const angle = lineAngle(roadFrm, crossFrm);
    if (angle < MIN_JUNCTION_ANGLE_RAD) continue;
    const hit = roadIntersection(road, crossing, 0.5);
    if (!hit || !isOnRoad(patrol, crossing, .42)) continue;
    const ep = egoProj ?? roadProject(road, report);
    const pp = roadProject(crossing, patrol);
    const gap = (hit.alongA - ep.along) * direction;
    const crossGap = hit.alongB - pp.along, crossSign = Math.sign(crossGap);
    if (gap < 7 || gap > 70 || Math.abs(crossGap) < 4 || Math.abs(crossGap) > 42 ||
        (crossing.flow && crossing.flow !== crossSign)) continue;
    const clampedPatrol = Math.min(crossFrm.maxAlong, Math.max(crossFrm.minAlong, pp.along));
    const heading = poseOnRoad(crossing, clampedPatrol, crossSign).heading;
    if (Math.abs(angleDelta(heading, patrol.heading)) > .42) continue;
    const evidence = Math.abs(report.speed), egoEta = gap / evidence;
    const intercept = patrol.squadRole === "INTERCEPTOR";
    const entryEta = Math.abs(crossGap) / Math.max(5, Math.min(12, Math.abs(patrol.speed) + 4)) +
      (intercept ? 2 : 0);
    if (entryEta > egoEta + (intercept ? 0 : 1.4)) continue;
    if (intercept && road.flow && road.flow !== direction) continue;
    const targetRoad = intercept ? road : crossing;
    const targetSign = intercept ? direction : crossSign;
    const tf = intercept ? roadFrm : crossFrm;
    const halfBody = (patrol.length ?? 0) / 2;
    const obliqueOffset = Math.max(12, (crossing.width / 2 + 6) / Math.max(0.5, Math.sin(angle)));
    let along = intercept ? hit.alongA + obliqueOffset * direction : hit.alongB - crossSign * 2.7;
    if (intercept && (along < tf.minAlong + halfBody || along > tf.maxAlong - halfBody))
      along = hit.alongA + 12 * direction;
    if (along < tf.minAlong + halfBody || along > tf.maxAlong - halfBody) continue;
    const goal = { ...poseOnRoad(targetRoad, along, targetSign), roadId: targetRoad.id };
    const junction = { x: hit.x, z: hit.z };
    choices.push({ id: `${crossing.id}:${targetSign}:${road.id}`, junction, goal, entryEta, egoEta,
      approach: road, direction, role: intercept ? "BLOCK_INTERCEPT" : "FLANK",
      score: Math.abs(egoEta - entryEta) + gap * .015 });
  }

  choices.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return choices[0] ?? null;
}

export function dispatchJunctionStillRelevant(route, report) {
  if (!route?.approach || !route?.junction || !report) return false;
  const { approach: road, direction, junction } = route;
  if (!isOnRoad(report, road, 2)) return false;
  const effective = report.speed < 0 ? report.heading + Math.PI : report.heading;
  if (!isDiagonalRoad(road) && (!road.flow || road.flow === direction)) {
    const clamped = Math.min(road.max, Math.max(road.min, report[road.axis]));
    const heading = districtRoadPose(road, clamped, direction).heading;
    return Math.abs(angleDelta(heading, effective)) < .72 &&
      (report[road.axis] - junction[road.axis]) * direction < 12;
  }
  const rf = roadFrame(road);
  const reportProj = roadProject(road, report);
  const junctionProj = roadProject(road, junction);
  const heading = direction >= 0 ? rf.heading : Math.atan2(-rf.ux, -rf.uz);
  return Math.abs(angleDelta(heading, effective)) < .72 &&
    (reportProj.along - junctionProj.along) * direction < 12;
}

export function dispatchRoadblockDetour(map, ego, road, direction, site, blockers) {
  const roadDiag = isDiagonalRoad(road);
  const rf = roadDiag ? roadFrame(road) : null;
  const egoAlong = roadDiag ? roadProject(road, ego).along : ego[road.axis];
  const siteAlong = typeof site === "number" ? site : roadProject(road, site).along;
  const progress = along => (along - egoAlong) * direction;
  const before = progress(siteAlong) - 8;
  const candidateBranches = [];
  for (const branch of map.drivingRoads) {
    if (branch.supportApron || branch.parkingBay || branch === road || branch.id === road.id) continue;
    if (!roadDiag && !isDiagonalRoad(branch)) {
      if (branch.axis !== road.axis &&
          branch.fixed >= road.min && branch.fixed <= road.max &&
          road.fixed >= branch.min && road.fixed <= branch.max &&
          progress(branch.fixed) >= 10 && progress(branch.fixed) <= before) {
        candidateBranches.push({ branch, alongB: road.fixed, minB: branch.min, maxB: branch.max });
      }
      continue;
    }
    const roadFrm = rf ?? roadFrame(road);
    const branchFrm = roadFrame(branch);
    if (lineAngle(roadFrm, branchFrm) < MIN_JUNCTION_ANGLE_RAD) continue;
    const hit = roadIntersection(road, branch, 0.5);
    if (!hit) continue;
    if (progress(hit.alongA) >= 10 && progress(hit.alongA) <= before)
      candidateBranches.push({ branch, alongB: hit.alongB, minB: branchFrm.minAlong, maxB: branchFrm.maxAlong });
  }

  const pointAlongRoad = point => roadDiag ? roadProject(road, point).along : point[road.axis];
  for (const { branch, alongB, minB, maxB } of candidateBranches) {
    for (const sign of branch.flow ? [branch.flow] : [1, -1]) {
      const along = alongB + sign * 24;
      if (along <= minB + 3 || along >= maxB - 3) continue;
      const goal = { ...poseOnRoad(branch, along, sign), roadId: branch.id };
      const path = planDistrictRoute(map, ego, goal);
      if (path.length < 3 || path.some(point => progress(pointAlongRoad(point)) > before + 3)) continue;
      // The public route guide uses rear-axle waypoints; check the actual SUV body
      // against both the proposed block and closures not in the turn cache.
      let pMinX = ego.x, pMaxX = ego.x, pMinZ = ego.z, pMaxZ = ego.z;
      for (let i = 0; i < path.length; i++) {
        const px = path[i].x, pz = path[i].z;
        if (px < pMinX) pMinX = px; else if (px > pMaxX) pMaxX = px;
        if (pz < pMinZ) pMinZ = pz; else if (pz > pMaxZ) pMaxZ = pz;
      }
      const localBlockers = Array.isArray(blockers)
        ? blockers.filter(b => b.x >= pMinX - 10 && b.x <= pMaxX + 10 && b.z >= pMinZ - 10 && b.z <= pMaxZ + 10)
        : blockers;
      let prior = ego;
      const axle = (ego.spec?.wheelbase ?? 2.6) / 2;
      let clear = true;
      for (let i = 1; i < path.length; i++) {
        const heading = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
        const pose = { ...ego, heading, x: path[i].x + axle * Math.sin(heading),
          z: path[i].z + axle * Math.cos(heading) };
        if (!sweepSafe(prior, pose, localBlockers).safe) { clear = false; break; }
        prior = pose;
      }
      if (clear) return goal;
    }
  }
  return null;
}

export function gtaJunctionCommand(world, car) {
  const s = world?.pursuit, ai = car?.gtaAI;
  if (!s || !ai) return null;
  if (!isDispatchTracked(s.response) || s.wantedLevel < 3 ||
      !["INTERCEPTOR", "FLANKER"].includes(car.squadRole) || car.aiState === "RECOVER" ||
      (ai.commitUntil ?? 0) > world.tick) {
    ai.junctionRoute = null;
    return null;
  }
  const role = car.squadRole === "INTERCEPTOR" ? "BLOCK_INTERCEPT" : "FLANK";
  if (ai.junctionRoute && (ai.junctionRoute.role !== role || world.tick >= ai.junctionRoute.expires ||
      !dispatchJunctionStillRelevant(ai.junctionRoute, s.response.lastSeen)))
    ai.junctionRoute = null;
  const drivingRoads = world.drivingRoads ?? s.patrolMap?.drivingRoads ?? [];
  const patrolMap = s.patrolMap ?? world.district;
  if (!ai.junctionRoute && world.tick >= (ai.nextJointCheck ?? 0)) {
    ai.nextJointCheck = world.tick + ticks(.35);
    const target = selectDispatchJunction(drivingRoads, car, s.response.lastSeen);
    if (target && patrolMap) {
      const path = planDistrictRoute(patrolMap, car, target.goal);
      if (path.length > 2)
        ai.junctionRoute = { ...target, path: Object.freeze(path.map(point => Object.freeze(point))), cursor: 0,
          expires: world.tick + ticks(Math.max(target.entryEta, target.egoEta) + 1.65) };
    }
  }
  const route = ai.junctionRoute;
  if (!route) return null;
  const { steer, targetSpeed, remaining, cursor } = followPath(car, route.path, route.cursor);
  route.cursor = cursor;
  if (remaining < 2) return null;
  car.aiState = route.role;
  return { steer, targetSpeed: Math.min(12.5, targetSpeed), reason: route.role };
}
