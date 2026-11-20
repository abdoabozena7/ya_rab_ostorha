import { World } from "../src/core/world.js";
import { angleDelta, distance } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { PURSUIT_DECISION_TICKS } from "../src/core/pursuit-policy.js";

export function runPursuitTrial({ seed, level, caseId = "ambient", policy = null,
  arm = "planner", choose, learn, maxSeconds = 36, prepare }) {
  const world = new World({ seed, pursuitLevel: level, pursuitCase: caseId }, "pursuit");
  if (policy) world.pursuit.policy = policy;
  const state = world.pursuit;
  state.trainingChoice = choose;
  prepare?.(world);
  if (arm === "hold") {
    world.command({ type: "mode", mode: "manual" }, false);
    world.command({ type: "pursuit-drive", action: PURSUIT_STOP }, false);
  }
  world.command({ type: "pursuit-run" }, false);
  const actions = {}, sectors = new Set(), routes = [], eventKinds = new Set();
  let approaches = 0, learnedDecisions = 0, errors = [];
  let actionHash = 2166136261, reverseDistanceM = 0, travelAfterReverseM = 0;
  const start = { ...world.player };
  const encounter = {
    incomingSide: Math.sign(world.actors.find(actor => actor.policeTactic === "flank")?.x ?? 0),
    earlyLateralM: 0, earlyForwardM: 0, earlyContacts: 0, heldForPerson: 0,
    simultaneousSectors: 0, rejected: {}, hiddenReadings: 0, recoveredTracks: 0,
  };
  const seenMissing = new Set(), reacquired = new Set();
  let firstContact = null;
  let farthestLateralM = 0, maxHeadingChangeRad = 0, lastPath = [];
  let previous = null;
  const measure = () => ({
    distance: world.metrics.distance,
    collisions: state.metrics.collisions ?? 0,
    pedestrians: state.metrics.pedestrianCollisions ?? 0,
    near: state.metrics.nearCollisions ?? 0,
  });
  const update = (decision, before, after, next, terminal) => {
    const advance = after.distance - before.distance;
    const hasSafeMove = decision.availableActions.some((index) => index < 6);
    const reward = Math.min(1.5, Math.max(0, advance)) * .2
      + (advance > .03 ? .035 : hasSafeMove ? -.18 : -.025)
      - (after.collisions - before.collisions) * 22
      - (after.pedestrians - before.pedestrians) * 90
      - (after.near - before.near) * .75
      + (terminal === "escaped" ? 36 : terminal === "captured" ? -24 : terminal === "crashed" ? -20 : 0);
    learn?.(decision.key, decision.index, reward, next?.key, next?.availableActions, Boolean(terminal));
  };
  while (state.phase === "running" && world.tick < maxSeconds * 60) {
    const before = measure();
    const poseBefore = { x: world.player.x, z: world.player.z, heading: world.player.heading };
    const first = world.tick;
    world.step();
    if (world.tick <= first) throw new Error("Running pursuit did not advance");
    const decision = state.decision;
    const acceptedDistance = distance(poseBefore, world.player);
    firstContact ??= state.metrics.impact;
    if (world.tick <= 180) {
      encounter.earlyLateralM = Math.max(encounter.earlyLateralM, Math.abs(world.player.x - start.x));
      encounter.earlyForwardM = Math.max(encounter.earlyForwardM, world.player.z - start.z);
      encounter.earlyContacts = state.metrics.collisions;
    }
    if (world.player.speed < -.05) reverseDistanceM += acceptedDistance;
    else if (world.player.speed > .05 && reverseDistanceM > .25) travelAfterReverseM += acceptedDistance;
    farthestLateralM = Math.max(farthestLateralM, Math.abs((world.player.x - start.x) * Math.cos(start.heading) -
      (world.player.z - start.z) * Math.sin(start.heading)));
    maxHeadingChangeRad = Math.max(maxHeadingChangeRad, Math.abs(angleDelta(world.player.heading, start.heading)));
    if (decision && previous?.decision !== decision) {
      if (previous) update(previous.decision, previous.before, before, decision, null);
      previous = { decision, before };
      approaches++;
      actionHash = Math.imul(actionHash ^ decision.index, 16777619) >>> 0;
      if (decision.source === "learned-tactical") learnedDecisions++;
      actions[decision.name] = (actions[decision.name] ?? 0) + 1;
      decision.threatSectors.forEach((value) => sectors.add(value));
      encounter.simultaneousSectors = Math.max(encounter.simultaneousSectors, decision.threatSectors.length);
      if (decision.action.throttle === 0 && decision.rejected.some(r => r.reason === "pedestrian"))
        encounter.heldForPerson++;
      for (const { reason } of decision.rejected)
        encounter.rejected[reason] = (encounter.rejected[reason] ?? 0) + 1;
      for (const [id, sighting] of state.sightings ?? []) {
        if (sighting.type === "static") continue;
        if (sighting.missing) {
          seenMissing.add(id);
          encounter.hiddenReadings++;
        } else if (sighting.motionKnown && seenMissing.has(id)) reacquired.add(id);
      }
      if (decision.routeId && (routes.at(-1)?.id !== decision.routeId ||
          world.player.path.some((point) => !lastPath.some((earlier) => distance(earlier, point) < 3)))) {
        lastPath = world.player.path;
        const pathLengthM = lastPath.reduce((sum, point, index) =>
          sum + (index ? distance(point, lastPath[index - 1]) : 0), 0);
        routes.push({ id: decision.routeId, tick: first, x: world.player.x, z: world.player.z,
          pathLengthM, shoulder: Boolean(world.pursuit.route?.shoulder) });
      }
    }
    if (world.tick % PURSUIT_DECISION_TICKS === 0)
      for (const event of state.events) eventKinds.add(event.kind);
    if (world.tick % 180 === 0) {
      errors = world.audit();
      if (errors.length) break;
    }
  }
  if (previous) update(previous.decision, previous.before, measure(), null,
    state.phase === "running" ? "window-end" : state.phase);
  encounter.recoveredTracks = reacquired.size;
  for (const event of state.events) eventKinds.add(event.kind);
  return {
    seed, level, caseId, arm, ticks: world.tick, survivalS: world.tick / 60,
    distanceM: world.metrics.distance,
    escape: state.phase === "escaped",
    outcome: state.phase === "running" ? "window-end" : state.phase,
    collisions: state.metrics.collisions ?? 0, pedestrianCollisions: state.metrics.pedestrianCollisions ?? 0,
    nearCollisions: state.metrics.nearCollisions ?? 0, approaches, learnedDecisions, actionHash,
    reverseDistanceM, travelAfterReverseM, farthestLateralM, maxHeadingChangeRad,
    maxSupportHeightM: state.metrics.maxSupportHeightM ?? 0,
    shoulderEntries: state.metrics.shoulderEntries ?? 0, shoulderExits: state.metrics.shoulderExits ?? 0,
    finalPose: { x: world.player.x, z: world.player.z, heading: world.player.heading, speed: world.player.speed },
    actions, routes, encounter, firstContact, threatSectors: [...sectors].sort(), eventKinds: [...eventKinds].sort(),
    police: world.actors.filter((actor) => actor.pursuitRole === "police").length,
    policeTactics: [...new Set(world.actors.filter(a => a.pursuitRole === "police").map(a => a.policeTactic))],
    errors: [...errors, ...world.audit()],
  };
}

export function summarizePursuit(runs) {
  const mean = (fn) => runs.reduce((sum, item) => sum + fn(item), 0) / runs.length;
  return {
    episodes: runs.length, averageSurvivalS: mean(run => run.survivalS),
    collisionRate: mean(run => Number(run.collisions > 0)),
    pedestrianCollisionRate: mean(run => Number(run.pedestrianCollisions > 0)),
    escapeRate: mean(run => Number(run.escape)),
    averageDistanceM: mean(run => run.distanceM),
    nearCollisions: runs.reduce((total, run) => total + run.nearCollisions, 0),
    learnedDecisions: runs.reduce((total, run) => total + run.learnedDecisions, 0),
  };
}
