import { STEP, VEHICLE } from "./config.js";
import { angleDelta, distance, overlaps } from "./geometry.js";
import { gtaLineClear } from "./pursuit-response.js";

export const PATROL_CHAIN_YIELD = "indirect-pedestrian-yield-v1";
export const PATROL_LATERAL_YIELD = "indirect-pedestrian-yield-v2";

export function patrolChainYield(world, patrol, command, lead, relative, impulseSpeed) {
  const alignment = Math.abs(angleDelta(lead.heading, patrol.heading));
  if (command.targetSpeed <= 0 || patrol.speed < 0 || relative.forward <= 0 ||
      Math.abs(relative.right) > (patrol.width + lead.width) * .42 ||
      alignment > .22 || Math.abs(lead.speed) > 2.5)
    return command;
  const braking = patrol.spec?.braking ?? VEHICLE.braking;
  const leadBraking = lead.spec?.braking ?? VEHICLE.braking;
  const gap = relative.forward - (lead.length + patrol.length) / 2;
  const margin = .65, delayS = .12;
  const approachSpeed = Math.max(patrol.speed, Math.min(command.targetSpeed, patrol.speed + .65));
  const reach = margin + approachSpeed * delayS + approachSpeed ** 2 / (2 * braking);
  if (gap > reach + .3 || gap < -.5) return command;
  if (!gtaLineClear(world, patrol, lead.x - patrol.x, lead.z - patrol.z, distance(patrol, lead))) return command;

  const closing = Math.max(0, approachSpeed - lead.speed);
  const projectedSpeed = Math.max(0, lead.speed + impulseSpeed(patrol, lead, closing));
  const front = Math.min(6, projectedSpeed * delayS + projectedSpeed ** 2 / (2 * leadBraking) + .32);
  const sin = Math.sin(lead.heading), cos = Math.cos(lead.heading);
  const lateralMargin = .035 + Math.min(.25, front * Math.sin(alignment) + Math.abs(relative.right) * .12);
  const swept = { type: lead.type, width: lead.width + 2 * lateralMargin, length: lead.length + front + .18,
    heading: lead.heading, x: lead.x + sin * (front + .18) / 2, z: lead.z + cos * (front + .18) / 2 };
  let atRisk = null;
  for (const person of world.actorIndex.near(lead, lead.length / 2 + front + 2.6)) {
    if (person.type !== "pedestrian" || !gtaLineClear(world, lead, person.x - lead.x, person.z - lead.z, distance(lead, person)))
      continue;
    const projectedWalkS = Math.min(.8, Math.max(0, gap) / Math.max(1, closing) + .15);
    for (const t of [0, projectedWalkS * .5, projectedWalkS]) {
      const walker = { type: "pedestrian", radius: person.radius,
        x: person.x + Math.sin(person.heading) * person.speed * t,
        z: person.z + Math.cos(person.heading) * person.speed * t };
      if ((walker.x - lead.x) * sin + (walker.z - lead.z) * cos < lead.length / 2 - .1) continue;
      if (overlaps(swept, walker)) {
        atRisk = person;
        break;
      }
    }
    if (atRisk) break;
  }
  if (!atRisk) return command;

  const response = braking * delayS;
  const permitted = Math.max(0, Math.sqrt(response ** 2 + 2 * braking * Math.max(0, gap - margin)) - response);
  if (permitted >= command.targetSpeed) return command;
  return { ...command, targetSpeed: patrol.speed > permitted + .1 ? 0 : permitted,
    reason: "indirect-pedestrian-yield", blockedBy: atRisk.id };
}

export function patrolLateralYield(world, patrol, command, lead, relative, advance, previewShove) {
  if (command.targetSpeed <= 0 || patrol.speed < 0 || relative.forward <= 0 || Math.abs(lead.speed) > 2.5)
    return command;
  const reactionS = .22;
  const braking = patrol.spec?.braking ?? VEHICLE.braking;
  const heldWalkerId = patrol.reason === "indirect-pedestrian-yield" ? patrol.blockedBy : null;
  const horizon = heldWalkerId ? 1.2 : Math.min(1.2, reactionS + Math.max(patrol.speed, Math.min(command.targetSpeed,
    patrol.speed + reactionS * (patrol.spec?.acceleration ?? VEHICLE.acceleration))) / braking);
  const egoRadius = Math.hypot(lead.width, lead.length) / 2;
  if (distance(patrol, lead) > egoRadius + Math.hypot(patrol.width, patrol.length) / 2 +
      horizon * (Math.max(patrol.speed, command.targetSpeed) + 2.5)) return command;
  const walkers = world.actorIndex.near(lead, egoRadius + 4).filter(person => person.type === "pedestrian" &&
    gtaLineClear(world, patrol, person.x - patrol.x, person.z - patrol.z, distance(patrol, person)));
  if (!walkers.length) return command;

  const brake = { steer: lead.steer, targetSpeed: 0 };
  let ego = lead, tail = patrol;
  const approachTicks = Math.ceil(horizon / STEP);
  for (let tick = 1; tick <= approachTicks; tick++) {
    ego = advance(ego, brake);
    tail = advance(tail, command);
    if (!overlaps(tail, ego)) continue;
    const pushed = previewShove(tail, ego);
    // A slowing patrol has less momentum, not necessarily a clear path.
    // Check renewed pressure at the commanded pace before releasing the yield.
    const restart = walkers.some(person => person.id === heldWalkerId) && command.targetSpeed > tail.speed
      ? previewShove({ ...tail, speed: command.targetSpeed }, ego) : null;
    if (!pushed && !restart) break;
    let shoved = pushed && { ...ego, ...pushed }, restarted = restart && { ...ego, ...restart };
    for (let offset = 1; offset <= 48; offset++) {
      ego = advance(ego, brake);
      if (shoved) shoved = advance(shoved, brake);
      if (restarted) restarted = advance(restarted, brake);
      const t = Math.min(.8, (tick + offset) * STEP);
      for (const person of walkers) {
        const projected = { type: "pedestrian", radius: person.radius,
          x: person.x + Math.sin(person.heading) * person.speed * t,
          z: person.z + Math.cos(person.heading) * person.speed * t };
        const restartConflict = restarted && person.id === heldWalkerId &&
          (overlaps(restarted, person) || overlaps(restarted, projected));
        if (((shoved && overlaps(shoved, projected)) || restartConflict) && !overlaps(ego, projected))
          return { ...command, targetSpeed: 0, reason: "indirect-pedestrian-yield", blockedBy: person.id };
      }
    }
    break;
  }
  return command;
}
