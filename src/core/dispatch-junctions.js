import { angleDelta, sweepSafe } from "./geometry.js";
import { districtRoadPose } from "./egypt-district.js";
import { planDistrictRoute } from "./district-navigation.js";

function isOnRoad(body, road, pad = 0) {
  const across = road.axis === "x" ? body.z : body.x;
  return Math.abs(across - road.fixed) <= road.width / 2 + pad &&
    body[road.axis] >= road.min - pad && body[road.axis] <= road.max + pad;
}

export function selectDispatchJunction(roads, patrol, report) {
  if (!report || Math.abs(report.speed) < 3) return null;
  const effective = report.speed < 0 ? report.heading + Math.PI : report.heading;
  const incoming = roads.filter(road => !road.supportApron && !road.parkingBay && isOnRoad(report, road))
    .map(road => ({ road, align: road.axis === "x" ? Math.sin(effective) : Math.cos(effective) }))
    .sort((a, b) => Math.abs(b.align) - Math.abs(a.align))[0];
  if (!incoming || Math.abs(incoming.align) < .86) return null;
  const { road } = incoming, direction = Math.sign(incoming.align), choices = [];
  for (const crossing of roads) {
    if (crossing.axis === road.axis || crossing.supportApron || crossing.parkingBay || crossing.width < 5 ||
        road.fixed < crossing.min || road.fixed > crossing.max ||
        crossing.fixed < road.min || crossing.fixed > road.max || !isOnRoad(patrol, crossing, .42)) continue;
    const gap = (crossing.fixed - report[road.axis]) * direction;
    const crossGap = road.fixed - patrol[crossing.axis], crossSign = Math.sign(crossGap);
    if (gap < 7 || gap > 70 || Math.abs(crossGap) < 4 || Math.abs(crossGap) > 42 ||
        (crossing.flow && crossing.flow !== crossSign)) continue;
    const heading = districtRoadPose(crossing, patrol[crossing.axis], crossSign).heading;
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
    if (along < targetRoad.min + patrol.length / 2 || along > targetRoad.max - patrol.length / 2) continue;
    const goal = { ...districtRoadPose(targetRoad, along, targetSign), roadId: targetRoad.id };
    const junction = road.axis === "x" ? { x: crossing.fixed, z: road.fixed } : { x: road.fixed, z: crossing.fixed };
    choices.push({ id: `${crossing.id}:${targetSign}:${road.id}`, junction, goal, entryEta, egoEta,
      approach: road, direction, role: intercept ? "BLOCK_INTERCEPT" : "FLANK",
      score: Math.abs(egoEta - entryEta) + gap * .015 });
  }

  choices.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return choices[0] ?? null;
}

export function dispatchJunctionStillRelevant(route, report) {
  const { approach: road, direction, junction } = route;
  const effective = report.speed < 0 ? report.heading + Math.PI : report.heading;
  const heading = districtRoadPose(road, report[road.axis], direction).heading;
  return isOnRoad(report, road, 2) && Math.abs(angleDelta(heading, effective)) < .72 &&
    (report[road.axis] - junction[road.axis]) * direction < 12;
}

export function dispatchRoadblockDetour(map, ego, road, direction, site, blockers) {
  const progress = along => (along - ego[road.axis]) * direction;
  const before = progress(site) - 8;
  const branches = map.drivingRoads.filter(branch =>
    branch.axis !== road.axis && !branch.supportApron && !branch.parkingBay &&
    branch.fixed >= road.min && branch.fixed <= road.max &&
    road.fixed >= branch.min && road.fixed <= branch.max &&
    progress(branch.fixed) >= 10 && progress(branch.fixed) <= before);
  for (const branch of branches) for (const sign of branch.flow ? [branch.flow] : [1, -1]) {
    const along = road.fixed + sign * 24;
    if (along <= branch.min + 3 || along >= branch.max - 3) continue;
    const goal = { ...districtRoadPose(branch, along, sign), roadId: branch.id };
    const path = planDistrictRoute(map, ego, goal);
    if (path.length < 3 || path.some(point => progress(point[road.axis]) > before + 3)) continue;
    // The public route guide uses rear-axle waypoints; check the actual SUV body
    // against both the proposed block and closures not in the turn cache.
    let prior = ego;
    const axle = (ego.spec?.wheelbase ?? 2.6) / 2;
    let clear = true;
    for (let i = 1; i < path.length; i++) {
      const heading = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      const pose = { ...ego, heading, x: path[i].x + axle * Math.sin(heading),
        z: path[i].z + axle * Math.cos(heading) };
      if (!sweepSafe(prior, pose, blockers).safe) { clear = false; break; }
      prior = pose;
    }
    if (clear) return goal;
  }
  return null;
}
