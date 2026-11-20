import { STEP, clamp } from "./config.js";
import { angleDelta } from "./geometry.js";
import { gtaLocal, isGtaStationary } from "./pursuit-gta.js";

// Each unit keeps a bearing and a staging offset in the reported SUV's frame.
// The first four go to different sides; backups fill the arcs between them.
const SLOTS = [
  { role: "tail",      bearing:  3.02, range: 18,   forward: -6.5, lateral:  0.8 },
  { role: "flank",     bearing:  1.67, range: 19.5, forward: -0.5, lateral:  7.4, openingRange: 7.6 },
  { role: "intercept", bearing: -0.15, range: 21,   forward:  7.1, lateral: -1.6 },
  { role: "flank",     bearing: -1.72, range: 19.5, forward: -1.2, lateral: -7.4, openingRange: 8.6 },
  { role: "tail",      bearing: -2.57, range: 22,   forward: -5.7, lateral: -3.4 },
  { role: "intercept", bearing:  0.71, range: 23,   forward:  5.9, lateral:  5.0 },
  { role: "tail",      bearing:  2.48, range: 23,   forward: -5.6, lateral:  4.3 },
  { role: "intercept", bearing: -0.78, range: 23,   forward:  5.3, lateral: -5.4 },
];

const slotFor = (order = 0) => SLOTS[order % SLOTS.length];
const ringFor = (order = 0) => Math.min(2, Math.floor(order / SLOTS.length));
const ageOf = (report, tick) => Math.max(0, tick - (report.tick ?? tick)) * STEP;
const headingTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

function offset(report, forward, lateral) {
  const s = Math.sin(report.heading), c = Math.cos(report.heading);
  return { x: report.x + s * forward + c * lateral, z: report.z + c * forward - s * lateral };
}

export function packTactic(order) {
  return slotFor(order).role;
}

export function packSpawnBias({ order, forward, lateral, range, alignment, opening, fronts = [] }) {
  const slot = slotFor(order);
  const bearing = Math.atan2(lateral, forward);
  const ring = ringFor(order);
  const closeFlank = opening && ring === 0 && slot.openingRange !== undefined;
  const desiredRange = closeFlank ? slot.openingRange : slot.range + 2.5 * ring + (opening ? 0 : 2);
  let crowding = 0;
  for (const other of fronts) {
    const gap = Math.abs(angleDelta(bearing, Math.atan2(other.lateral, other.forward)));
    const sharedArc = Math.max(0, 1 - gap / (Math.PI / 2));
    crowding = Math.max(crowding, 33 * sharedArc ** 2);
  }
  // A parallel flank can occupy the nearby lane without charging head-on.
  // A transverse lane is still useful if there is no nearby parallel slot.
  const parallel = closeFlank ? clamp((20 - range) / 10, 0, 1) : 0;
  const alignmentCost = slot.role === "tail" ? 5 * (1 - alignment)
    : slot.role === "intercept" ? 4 * (1 + alignment)
      : (1 - parallel) * 5 * Math.abs(alignment) + parallel * 6 * (1 - alignment);
  return Math.abs(range - desiredRange) * .68 +
    Math.abs(angleDelta(bearing, slot.bearing)) * (closeFlank ? 13 : 10) + alignmentCost + crowding;
}

/** Route destination, not permission to drive straight to it. Unsighted reports get no lead. */
export function packApproach({ car, report, order, street, tick, startedTick, clear }) {
  const hold = () => ({ x: car.x, z: car.z, heading: car.heading, speed: 0 });
  if (!report) return hold();
  const slot = slotFor(order);
  const range = Math.hypot(car.x - report.x, car.z - report.z);
  const age = ageOf(report, tick);
  const freshness = clear === false ? 0 : clamp(1 - age / .8, 0, 1);
  const canUse = typeof clear === "function" ? clear : null;
  const opening = clamp(1 - (tick - (startedTick ?? tick)) * STEP / 2.4, 0, 1);
  const spread = .91 + .23 * opening + .13 * ringFor(order);
  const measuredSpeed = report.speed ?? 0;
  const horizon = street ? clamp(.34 + range * .018, .38, .84) : clamp(.22 + range * .016, .24, .62);
  const leadLimit = street ? 7.2 : 5.4;
  const lead = clamp(measuredSpeed * horizon, -leadLimit, leadLimit) * freshness;
  const speed = clamp((street ? 7.4 : 5.8) + .58 * Math.abs(measuredSpeed) * freshness +
    .064 * range, 0, street ? 15.5 : 10.8);
  const centre = offset(report, lead, 0);
  // Keep the side assignment first. Only fall back to the last observed
  // position when both spread-out points are unusable.
  for (const scale of [spread, spread * .49, 0]) {
    const point = scale ? offset(report, lead + slot.forward * scale, slot.lateral * scale)
      : { x: report.x, z: report.z };
    const heading = scale ? headingTo(point, centre) : headingTo(car, point);
    const aim = { ...point, heading, speed };
    if (!canUse || canUse(aim)) return aim;
  }
  return hold();
}

/**
 * Close-range direct candidate. The caller must gate on line of sight, legal
 * road sweep and other bodies. A stale report cannot authorize a direct move.
 */
export function packRamAim({ car, report, order, tick, startedTick }) {
  if (!report || ageOf(report, tick) > .3) return null;
  const range = Math.hypot(car.x - report.x, car.z - report.z);
  const progress = clamp((tick - (startedTick ?? tick)) * STEP / 3, 0, 1);
  if (range > 12.5 + 13.5 * progress) return null;
  const slot = slotFor(order);
  const measuredSpeed = report.speed ?? 0;
  const lead = clamp(measuredSpeed * clamp(range / (Math.max(3, car.speed ?? 0) + 10), .08, .55), -5.2, 5.2);
  const staging = clamp((range - 6) / 17, 0, 1);
  const openingPace = (slot.role === "flank" ? 3.8 : 4.6) + .2 * Math.min(8, Math.abs(measuredSpeed));
  const speed = Math.min(5.1 + .82 * Math.abs(measuredSpeed) + .095 * range,
    openingPace + (15.5 - openingPace) * progress ** 1.5);
  const projected = offset(report, lead + .16 * slot.forward * staging, .35 * slot.lateral * staging);
  for (const point of [projected, offset(report, lead, 0), report]) {
    const heading = headingTo(car, point);
    if (Math.hypot(point.x - car.x, point.z - car.z) < .35 ||
        Math.abs(angleDelta(heading, car.heading)) > (range < 9 ? .87 : .73)) continue;
    return { x: point.x, z: point.z, heading, speed };
  }
  return null;
}

export function assignGtaSquad(patrols, report) {
  const slots = [...patrols].filter(unit => !isGtaStationary(unit)).map(unit => ({
    unit, ...gtaLocal(report, unit), previousRole: unit.squadRole, previousSide: unit.squadSide,
  }));
  for (const { unit } of slots) {
    unit.squadRole = "SUPPORT";
    unit.squadSide = 0;
  }
  const assign = (role, side, forward, right, typeBias) => {
    const score = slot => Math.hypot((slot.forward - forward) * .85, slot.right - right) +
      typeBias(slot.unit.unitType) - (slot.previousRole === role && slot.previousSide === side ? 1.5 : 0);
    slots.sort((a, b) => score(a) - score(b) || a.unit.gtaAI.order - b.unit.gtaAI.order);
    const chosen = slots.shift()?.unit;
    if (chosen) {
      chosen.squadRole = role;
      chosen.squadSide = side;
    }
  };
  const count = slots.length;
  assign("PRIMARY_CHASER", 0, -9, 0, type => type === "swat" ? 9 : 0);
  const fast = type => type === "interceptor" ? -8 : type === "swat" ? 4 : 0;
  if (count >= 4) assign("INTERCEPTOR", 1, 17, 3, fast);
  if (count >= 6) assign("INTERCEPTOR", -1, 21, -3, fast);
  assign("FLANKER", -1, 0, -7, type => type === "swat" ? 5 : 0);
  assign("FLANKER", 1, 0, 7, type => type === "swat" ? 5 : 0);
}

export function gtaSpacingSteer(car, patrols) {
  let bias = 0;
  for (const other of patrols) {
    if (other === car || isGtaStationary(other)) continue;
    const { forward, right } = gtaLocal(car, other);
    const distance = Math.hypot(forward, right);
    if (Math.abs(right) > 4.8 || distance > 9) continue;
    const side = Math.abs(right) > .25 ? Math.sign(right) : car.gtaAI.order < other.gtaAI.order ? 1 : -1;
    bias -= side * .14 * (1 - distance / 9);
  }
  return clamp(bias, -.19, .19);
}
