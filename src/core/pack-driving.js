import { STEP, VEHICLE, clamp } from "./config.js";
import { pursuitCommand } from "./pursuit-controls.js";
import { Random } from "./random.js";

export const PACK_ACTIONS = Object.freeze([
  "follow", "forward", "left", "right", "tight-left", "tight-right",
  "ease", "hold", "reverse-left", "reverse-right", "reverse",
  "creep", "creep-left", "creep-right",
]);
export const PACK_PENALTIES = Object.freeze({ police: 120, pedestrian: 240 });

export function pedestrianImpactCost(closingMps) {
  return PACK_PENALTIES.pedestrian + Math.round(clamp(closingMps, 0, 15) * 8);
}

export function packCommand(body, action, dt = STEP) {
  const command = pursuitCommand(body, action, dt);
  const speed = Math.max(Math.abs(body.speed ?? 0), Math.abs(command.targetSpeed));
  const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
  const curveLimit = Math.atan2(4.6 * wheelbase, speed ** 2);
  const desired = clamp(command.steer, -curveLimit, curveLimit);
  const accepted = body.steer ?? 0;
  const maxChange = .88 * dt;
  // Unwind toward a new speed-dependent target instead of clipping the accepted wheels.
  command.steer = accepted + clamp((desired - accepted) * -Math.expm1(-dt / .14), -maxChange, maxChange);
  return command;
}

const SCHEMA = 1;
const ALGORITHM = "pack-tabular-q-learning";
const HOLD = PACK_ACTIONS.indexOf("hold");
const MAX_STATES = 5 * 3 ** 3;
const MAX_Q = 4096;
const KEY = /^pack-v1:(?:none|front|rear|left|right):[0-2]:(?:reverse|slow|moving):[0-2]$/;
const validKey = key => typeof key === "string" && KEY.test(key);
const validIndex = index => Number.isInteger(index) && index >= 0 && index < PACK_ACTIONS.length;

// Hand-set priors over checked maneuvers, not a trained checkpoint.
export function starterPackPolicy() {
  const q = {};
  for (const threat of ["none", "front", "rear", "left", "right"])
    for (let crowd = 0; crowd < 3; crowd++)
      for (const pace of ["reverse", "slow", "moving"])
        for (let openings = 0; openings < 3; openings++) {
          const row = [1.4, 1, .6, .6, .15, .15, 0, -.5, -.8, -.8, -.7, .35, .15, .15];
          if (threat === "rear") {
            row[1] += 3;
            row[7] -= 2;
          } else if (threat === "front") {
            for (const index of [2, 3, 8, 9, 10]) row[index] += pace === "slow" ? 2.8 : 1.4;
            row[1] -= 1.5;
          } else if (threat === "left" || threat === "right") {
            const right = threat === "left";
            row[right ? 3 : 2] += 2.6;
            row[right ? 5 : 4] += 1.1;
          }
          if (openings === 0 && pace !== "moving")
            for (const index of [8, 9, 10]) row[index] += 1.6;
          q[`pack-v1:${threat}:${crowd}:${pace}:${openings}`] = row;
        }
  return { schemaVersion: SCHEMA, algorithm: ALGORITHM, actions: [...PACK_ACTIONS], updates: 0, q };
}

export function validatePackPolicy(checkpoint) {
  if (!checkpoint || Object.getPrototypeOf(checkpoint) !== Object.prototype ||
      checkpoint.schemaVersion !== SCHEMA || checkpoint.algorithm !== ALGORITHM ||
      !Number.isSafeInteger(checkpoint.updates) || checkpoint.updates < 0 ||
      !Array.isArray(checkpoint.actions) || checkpoint.actions.length !== PACK_ACTIONS.length ||
      !PACK_ACTIONS.every((name, i) => Object.hasOwn(checkpoint.actions, i) && checkpoint.actions[i] === name) ||
      !checkpoint.q || Object.getPrototypeOf(checkpoint.q) !== Object.prototype)
    throw new Error("Unsupported pack policy checkpoint");
  const rows = Object.entries(checkpoint.q);
  if (rows.length > MAX_STATES || rows.some(([key, row]) =>
    !validKey(key) || !Array.isArray(row) || row.length !== PACK_ACTIONS.length ||
    !PACK_ACTIONS.every((_, i) => Object.hasOwn(row, i) && Number.isFinite(row[i]) && Math.abs(row[i]) <= MAX_Q)))
    throw new Error("Invalid pack policy weights");
  return checkpoint;
}

function measured(metrics) {
  const values = {
    distanceM: metrics?.distanceM ?? metrics?.progress,
    collisions: metrics?.collisions ?? 0,
    policeContacts: metrics?.policeContacts ?? 0,
    pedestrianCollisions: metrics?.pedestrianCollisions ?? 0,
    nearCollisions: metrics?.nearCollisions ?? 0,
    survivalS: metrics?.survivalS ?? null,
    guard: typeof metrics?.guard === "string" ? metrics.guard.slice(0, 40) : null,
    pedestrianDanger: metrics?.pedestrianDanger ?? 0,
    pedestrianCost: metrics?.pedestrianCost ?? 0,
    pedestrianCleared: metrics?.pedestrianCost !== undefined && metrics.firstClearTick != null ? 1 : 0,
  };
  if (!Number.isFinite(values.distanceM) || values.distanceM < 0 ||
      [values.collisions, values.policeContacts, values.pedestrianCollisions, values.nearCollisions]
        .some(value => !Number.isSafeInteger(value) || value < 0) ||
      (values.survivalS !== null && (!Number.isFinite(values.survivalS) || values.survivalS < 0))) return null;
  return values;
}

function executed(decision, before) {
  if (!before || !validKey(decision?.key) || !validIndex(decision.index) ||
      !Array.isArray(decision.availableActions)) return null;
  const safe = decision.availableActions.filter(validIndex);
  const forcedHold = decision.forcedHold === true && decision.availableActions.length === 0 && decision.index === HOLD;
  if (!forcedHold && !safe.includes(decision.index)) return null;
  return {
    key: decision.key, index: decision.index, safe, before, forcedHold,
    source: decision.source === "learned-tactical" || decision.source === "exploration"
      ? decision.source : "rollout",
    lookup: decision.policyLookup === true && safe.length > 0,
    changed: decision.changed === true && decision.index === decision.learnedIndex,
  };
}

export function createPackLearner(seed, checkpoint = null, training = true) {
  if (checkpoint !== null) validatePackPolicy(checkpoint);
  const rng = new Random(`${seed}:pack-learning-v1`);
  const q = Object.create(null);
  for (const [key, row] of Object.entries(checkpoint?.q ?? {}))
    q[key] = training ? [...row] : Object.freeze([...row]);
  if (!training) Object.freeze(q);
  const weights = Object.freeze({ q });
  let prior = null, lastTransition = null;
  let updates = checkpoint?.updates ?? 0;
  let states = Object.keys(q).length, explored = 0, lookups = 0, changedDecisions = 0;

  function settle(after, next, terminal) {
    if (!prior || !after) return;
    const { key, index, before, forcedHold, source, lookup, changed } = prior;
    const deltas = {
      distanceM: after.distanceM - before.distanceM,
      collisions: after.collisions - before.collisions,
      policeContacts: after.policeContacts - before.policeContacts,
      pedestrianCollisions: after.pedestrianCollisions - before.pedestrianCollisions,
      nearCollisions: after.nearCollisions - before.nearCollisions,
      elapsedS: after.survivalS !== null && before.survivalS !== null ? after.survivalS - before.survivalS : 0,
      ...(after.pedestrianCost !== before.pedestrianCost ? { pedestrianCost: after.pedestrianCost - before.pedestrianCost } : {}),
      ...(after.pedestrianDanger !== before.pedestrianDanger ? { pedestrianDanger: after.pedestrianDanger - before.pedestrianDanger } : {}),
      ...(after.pedestrianCleared > before.pedestrianCleared ? { pedestrianCleared: 1 } : {}),
    };
    const values = Object.values(deltas);
    if (values.some(value => value < 0) || values.every(value => value === 0)) return;
    const { distanceM, policeContacts, pedestrianCollisions, collisions, nearCollisions, elapsedS } = deltas;
    const contactCost = policeContacts * PACK_PENALTIES.police +
      (deltas.pedestrianCost ?? pedestrianCollisions * PACK_PENALTIES.pedestrian);
    const otherContacts = Math.max(0, collisions - policeContacts - pedestrianCollisions);
    const cause = pedestrianCollisions ? "pedestrian-impact" : policeContacts ? "police-contact" :
      collisions ? "contact" : terminal ?? (deltas.pedestrianDanger ? "pedestrian-danger" :
        nearCollisions ? "near-contact" : distanceM > .05 ? "progress" : "held");
    const reward = contactCost ? -contactCost - otherContacts * 8 :
      .55 * Math.min(distanceM, 3) - .45 * elapsedS - otherContacts * 8 - nearCollisions * 1.4 +
      (deltas.pedestrianCleared ?? 0) * 2 - (deltas.pedestrianDanger ?? 0) * 6 +
      (terminal === "escaped" ? 14 : terminal === "captured" ? -12 : terminal === "timeout" ? -4 : 0);
    const qBefore = q[key]?.[index] ?? 0;
    let qAfter = qBefore;
    if (training) {
      const future = next?.safe.length ? Math.max(...next.safe.map(i => q[next.key]?.[i] ?? 0)) : 0;
      if (!q[key]) {
        q[key] = PACK_ACTIONS.map(() => 0);
        states++;
      }
      qAfter = clamp(qBefore + .30 * (reward + .88 * future - qBefore), -MAX_Q, MAX_Q);
      q[key][index] = qAfter;
      updates = Math.min(Number.MAX_SAFE_INTEGER, updates + 1);
    }
    if (training && source === "exploration") explored++;
    if (lookup) lookups++;
    if (lookup && changed) changedDecisions++;
    lastTransition = Object.freeze({
      key, action: PACK_ACTIONS[index], index, next: next?.key ?? null, reward,
      deltas: Object.freeze(deltas), cause, terminal, forcedHold, source, guard: after.guard,
      qBefore, qAfter,
    });
  }

  return {
    weights,
    choose(_key, safe, best) {
      if (!training || safe.length < 2 || rng.next() >= .14) return best;
      const alternatives = safe.filter(index => index !== best);
      return alternatives.length ? rng.pick(alternatives) : best;
    },
    record(decision, metrics) {
      const after = measured(metrics);
      const next = executed(decision, after);
      settle(after, next, null);
      prior = next;
    },
    finish(metrics, phase) {
      settle(measured(metrics), null, typeof phase === "string" ? phase.slice(0, 32) : null);
      prior = null;
    },
    interrupt() { prior = null; },
    snapshot() {
      return { updates, states, explored, lookups, changedDecisions, lastTransition,
        lastReward: lastTransition?.reward ?? null, lastCause: lastTransition?.cause ?? null };
    },
    checkpoint() {
      return { schemaVersion: SCHEMA, algorithm: ALGORITHM, actions: [...PACK_ACTIONS], updates,
        q: Object.fromEntries(Object.entries(q).map(([key, row]) => [key, [...row]])) };
    },
  };
}
