import { angleDelta, distance } from "./geometry.js";
import { isTacticalPursuit, tacticalPatrolPace, tacticalSquadCap } from "./pako-tactical-police.js";
import { DISPATCH_RULESET } from "./pursuit-dispatch.js";
import { gtaLineClear } from "./pursuit-response.js";

export const AGGRESSIVE_CHASE_PRESENCE = "city-chase-v1";

function localPose(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const sin = Math.sin(from.heading), cos = Math.cos(from.heading);
  return { forward: dx * sin + dz * cos, right: dx * cos - dz * sin };
}

function isStationary(actor) {
  return actor?.aiState === "WRECKED" || actor?.aiState === "ROADBLOCK";
}

function bandPenalty(value, min, max, weight = 1) {
  if (value < min) return (min - value) * weight;
  if (value > max) return (value - max) * weight;
  return 0;
}

function preferredFlankSide(player, others, car, patrolCount) {
  let left = 0, right = 0;
  for (const other of others) {
    const rel = localPose(player, other);
    if (rel.right > 2) right++;
    else if (rel.right < -2) left++;
  }
  if (right !== left) return right > left ? -1 : 1;
  return (car?.gtaAI?.order ?? patrolCount) % 2 ? -1 : 1;
}

export function isAggressiveChase(state) {
  return Boolean(
    isTacticalPursuit(state) ||
      (state?.gta?.config?.ruleset === DISPATCH_RULESET &&
        state.gta.config.chasePresence === AGGRESSIVE_CHASE_PRESENCE),
  );
}

export function aggressiveSquadCap(pursuitOrWanted, maxActivePatrols) {
  if (typeof pursuitOrWanted === "number") {
    return tacticalSquadCap(pursuitOrWanted, maxActivePatrols ?? 14);
  }
  const wanted = Math.min(5, Math.max(1, Math.round(pursuitOrWanted?.wantedLevel ?? 1)));
  const cap = maxActivePatrols ?? pursuitOrWanted?.gta?.config?.maxActivePatrols ?? 14;
  if (isTacticalPursuit(pursuitOrWanted)) {
    return tacticalSquadCap(wanted, cap);
  }
  return Math.min(cap, [0, 3, 5, 7, 9, cap][wanted]);
}

export function aggressiveDeploymentBounds(state, opening) {
  const minSpawn = state?.gta?.config?.minSpawnRadius ?? 16;
  const count = state?.patrols?.size ?? 0;
  if (opening) {
    if (count < 2) return { minRange: Math.max(17.5, minSpawn), maxRange: 33 };
    if (isTacticalPursuit(state)) {
      return count < 5
        ? { minRange: Math.max(28, minSpawn), maxRange: 68 }
        : { minRange: Math.max(35, minSpawn), maxRange: 95 };
    }
    return { minRange: 36, maxRange: 66 };
  }
  return { minRange: 26, maxRange: 58 };
}

export function scoreAggressiveDeploymentSlots(
  world,
  state,
  car,
  player,
  slots,
  tactic,
  opening,
  forwardOnly = false,
) {
  const others = state?.patrols ? [...state.patrols].filter(other => other !== car) : [];
  const count = state?.patrols?.size ?? others.length;
  const side = preferredFlankSide(player, others, car, count);
  const checkLineClear = Boolean(opening && count < 2 && world?.staticIndex && Array.isArray(world.statics));
  const spacingRadius = opening && count >= 2 ? 20 : 15;
  const spacingWeight = opening && count >= 2 ? 1.6 : 1.4;

  for (const slot of slots) {
    const { forward, right } = localPose(player, slot.position);
    const range = distance(player, slot.position);
    const alignment = Math.cos(angleDelta(slot.position.heading, player.heading));
    const absRight = Math.abs(right);

    if (forwardOnly && forward <= 2) {
      slot.score = Infinity;
      continue;
    }
    const tacticalOpening = opening && isTacticalPursuit(state);
    if (tacticalOpening && forward > 0 && forward < 34) {
      slot.score = Infinity;
      continue;
    }
    if (opening && forward > -1 && forward < 16.5 && absRight < 2.6) {
      slot.score = Infinity;
      continue;
    }

    const crossStreet = Math.abs(alignment) <= 0.65;
    const sameForwardCorridor =
      forward > -2 && forward < 42 && Math.abs(alignment) > 0.65 && absRight < 7.5;
    let score = 0;

    if (opening && count < 2) {
      if (sameForwardCorridor) score += 65;
      if (checkLineClear && !gtaLineClear(world, player, slot.position.x - player.x, slot.position.z - player.z, range)) {
        score += 14;
      }

      const rearBerthScore =
        bandPenalty(forward, -31, -17, 1.6) +
        (forward > -8 ? 22 : 0) +
        bandPenalty(range, 18, 31, 1.4) +
        Math.abs(range - 21.5) * 0.24 +
        Math.max(0, absRight - 6.5) * 1.9 +
        absRight * 0.18 +
        (alignment > 0.65 ? (1 - alignment) * 3 : 20 + (0.65 - alignment) * 10);

      const towardPlayer =
        ((player.x - slot.position.x) * Math.sin(slot.position.heading) +
          (player.z - slot.position.z) * Math.cos(slot.position.heading)) /
        Math.max(1, range);
      const crossBerthScore =
        (crossStreet ? 0 : 26 + (Math.abs(alignment) - 0.65) * 18) +
        bandPenalty(range, 18, 31, 1.45) +
        Math.abs(range - 24.5) * 0.24 +
        Math.max(0, absRight - 18) * 1.2 +
        Math.max(0, -towardPlayer) * 3.5 +
        (tactic === "intercept" && forward > 6 ? -2.5 : 0) +
        (tactic === "flank" && absRight >= 2.5 && right * side < 0 ? 3.5 : 0);

      if (tactic === "tail" && count === 0) {
        score += Math.min(rearBerthScore, crossBerthScore + 8);
      } else if (tactic === "tail") {
        score += Math.min(rearBerthScore, crossBerthScore + 4);
      } else {
        score += Math.min(crossBerthScore, rearBerthScore + 6);
      }
    } else if (opening && isTacticalPursuit(state)) {
      const towardPlayer =
        ((player.x - slot.position.x) * Math.sin(slot.position.heading) +
          (player.z - slot.position.z) * Math.cos(slot.position.heading)) /
        Math.max(1, range);
      const opposingLane = alignment < -0.65 && absRight >= 2.4 && absRight <= 8.5;
      const forwardCrossApproach = crossStreet && towardPlayer > 0.15;
      if (count < 5) {
        score +=
          bandPenalty(forward, 34, 72, 1.9) +
          bandPenalty(range, 28, 68, 1.35) +
          Math.abs(range - (38 + (count - 2) * 8)) * 0.32 +
          (forwardCrossApproach ? -22 : crossStreet ? -10 : opposingLane ? -16 : 18) +
          (sameForwardCorridor && !opposingLane ? 16 : 0) +
          (tactic === "intercept" && forwardCrossApproach ? -8 : 0) +
          (tactic === "flank" && right * side < 0 ? 5 : 0);
      } else {
        const parallelFlank = absRight >= 8 || crossStreet;
        score +=
          bandPenalty(forward, 35, 95, 1.35) +
          bandPenalty(range, 35, 95, 1.1) +
          Math.abs(range - Math.min(88, 58 + (count - 5) * 5)) * 0.28 +
          (parallelFlank ? -8 : opposingLane ? -6 : 12) +
          (tactic === "intercept" && forwardCrossApproach ? -7 : 0) +
          (tactic === "flank" && right * side < 0 ? 4 : 0);
      }
    } else if (opening) {
      if (sameForwardCorridor) score += 65;
      const targetRange = Math.min(62, Math.max(38, 42 + (count - 2) * 3));
      const avenueApproach = crossStreet || absRight >= 10 || forward < -16;
      score +=
        bandPenalty(range, 38, 62, 1.35) +
        Math.abs(range - targetRange) * 0.65 +
        (avenueApproach ? 0 : 24) +
        (tactic === "flank" && right * side < 0 ? 4.5 : 0) +
        (tactic === "intercept" && crossStreet && forward > 0 ? -3 : 0) +
        (tactic === "tail" ? (forward < -10 ? -2.5 : 3) : 0);
    } else if (tactic === "intercept") {
      const frontVisible = absRight >= 2.4 || crossStreet;
      score +=
        (range < 26 ? 30 + (26 - range) * 4 : 0) +
        bandPenalty(forward, 20, 50, 1.65) +
        (forward < 0 ? 18 : 0) +
        (frontVisible ? 0 : 10) +
        bandPenalty(absRight, 0, 18, 0.9) +
        bandPenalty(range, 26, 54, 1.0) +
        Math.abs(range - 34) * 0.22;
    } else if (tactic === "flank") {
      score +=
        (forward > 8 && range < 26 ? 22 + (26 - range) * 3 : 0) +
        bandPenalty(forward, -8, 32, 1.3) +
        bandPenalty(absRight, 2.5, 20, 1.8) +
        (right * side < 0 ? 9.5 : 0) +
        bandPenalty(range, 26, 52, 0.9) +
        Math.abs(range - 32) * 0.22;
    } else {
      score +=
        bandPenalty(forward, -42, -18, 1.45) +
        (forward > -4 ? 16 : 0) +
        Math.max(0, absRight - 5) * 1.8 +
        absRight * 0.2 +
        (alignment > 0.65 ? (1 - alignment) * 3 : 15 + (0.65 - alignment) * 8) +
        bandPenalty(range, 26, 50, 0.9) +
        Math.abs(range - 30) * 0.22;
    }

    for (const other of others) {
      score += Math.max(0, spacingRadius - distance(other, slot.position)) * spacingWeight;
    }
    slot.score = score;
  }

  return slots.sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? -1 : 1));
}

export function aggressiveInitialSpeed(car, opening, wantedLevel = 1) {
  return Math.min(car.maxSpeed, (opening ? 4.5 : 7.0) + Math.max(1, wantedLevel ?? 1) * 0.75);
}

export function aggressivePatrolPace(pursuit, car, reportSpeed, range) {
  if (isTacticalPursuit(pursuit)) {
    return tacticalPatrolPace(pursuit, car, reportSpeed, range);
  }
  const wanted = pursuit?.wantedLevel ?? 1;
  const levelCap = [17.5, 17.5, 19.5, 21.5, 23.0, 24.8][Math.min(5, Math.max(1, wanted))];
  const speed = Number.isFinite(reportSpeed) ? Math.abs(reportSpeed) : 0;
  return Math.min(
    car.maxSpeed,
    levelCap,
    Math.max(8.5, speed * 1.04 + 2.6 + wanted * 0.55 + range * 0.10) *
      (pursuit?.gta?.config?.npcSpeedMultiplier ?? 1),
  );
}

export function recycleTrailingChasePatrols(world, deployPatrol, removePatrol) {
  const pursuit = world?.pursuit;
  if (pursuit?.gta?.config?.policeFairness === "city-fair-v1") return 0;
  if (!isAggressiveChase(pursuit)) return 0;
  if (pursuit.phase && pursuit.phase !== "running") return 0;

  const tactical = isTacticalPursuit(pursuit);
  if (tactical && (pursuit.response?.unitsInContact ?? 0) === 0) {
    if (pursuit.patrols) {
      for (const car of pursuit.patrols) {
        if (!car?.gtaAI) continue;
        car.gtaAI.chaseFarTicks = 0;
        car.gtaAI.chaseStallTicks = 0;
      }
    }
    return false;
  }

  if (!tactical && pursuit.response?.dispatch?.state !== "ZONE_TRACKED") {
    for (const car of pursuit.patrols) {
      if (!car?.gtaAI) continue;
      car.gtaAI.chaseFarTicks = 0;
      car.gtaAI.chaseStallTicks = 0;
    }
    return 0;
  }

  const farThreshold = tactical ? 135 : 82;
  const stallGapThreshold = tactical ? 135 : 30;
  let recycled = 0;
  for (const car of [...(pursuit.patrols ?? [])]) {
    if (isStationary(car)) continue;
    const ai = (car.gtaAI ??= {});
    const rel = localPose(world.player, car);
    const gap = distance(world.player, car);
    const moved = car.previous ? distance(car, car.previous) : 0;

    ai.chaseFarTicks = gap > farThreshold && rel.forward < -14 ? (ai.chaseFarTicks ?? 0) + 1 : 0;
    ai.chaseStallTicks = gap > stallGapThreshold && moved < 0.025 && Math.abs(car.speed) < 1.1
      ? (ai.chaseStallTicks ?? 0) + 1 : 0;

    if (
      recycled < 1 &&
      (ai.chaseFarTicks >= 150 || ai.chaseStallTicks >= 180) &&
      (world.tick ?? 0) >= (ai.nextAggressiveRecycle ?? 0)
    ) {
      ai.nextAggressiveRecycle = (world.tick ?? 0) + 150;
      const replacement =
        deployPatrol("flank", car.unitType, false) ??
        deployPatrol("tail", car.unitType, false);
      if (replacement) {
        removePatrol(car);
        recycled++;
      }
    }
  }
  return recycled;
}
