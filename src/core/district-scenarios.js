import { STEP, VEHICLE } from "./config.js";
import { distance } from "./geometry.js";
import { Random } from "./random.js";
import { createPedestrianBody } from "./pedestrian-body.js";
import { walkSegmentClear } from "./walk-route.js";
import { stepDistrictPedestrian } from "./district-behavior.js";
import { districtRoadPose } from "./egypt-district.js";

export const DISTRICT_CASES = Object.freeze([
  ["ambient", "District life", "The requested seeded population, without a clean-case fixture."],
  ["visible-left", "Visible crossing · left", "An actual walker enters from the left after the ego reaches the approach marker."],
  ["visible-right", "Visible crossing · right", "The mirrored actual crossing with the same physical walking bounds."],
  ["diagonal-hesitant", "Diagonal and hesitation", "A walker reaches a diagonal intermediate point, holds, then resumes."],
  ["partial-occluded-history", "Partial occlusion and history", "Actual movement beside the registered occluder supplies only the pixels that are visible."],
  ["fully-hidden-emergence", "Hidden emergence", "A walker emerges from behind the registered vehicle; the map cannot know it is there."],
  ["same-occluder-empty", "Same occluder · empty", "The same static occluder and seeded draws, without the walker."],
  ["stationary-curb", "Stationary curb", "A real stationary person is not a crossing instruction."],
  ["parallel-away", "Parallel walking", "A bounded walker follows the declared curb away from the ego."],
  ["blind-corner-empty", "Blind corner · empty", "Static mapped caution without a hidden pedestrian."],
  ["two-car-narrow-passage", "Opposing narrow passage", "Construction-time opposing vehicles share the actual fair passage resource."],
  ["queue-alternate-route", "Queue and alternate route", "Construction-time traffic queues and may replan without changing its pose."],
  ["camera-loss-recovery", "Camera loss and recovery", "The same actual crossing; camera withholding and recovery are external observations, not actor cues."],
].map(([id, label, description]) => Object.freeze({ id, label, description })));

const EMPTY_CASES = new Set([
  "same-occluder-empty", "blind-corner-empty",
  "two-car-narrow-passage", "queue-alternate-route",
]);
const CROSSING_CASES = new Set([
  "visible-left", "visible-right", "diagonal-hesitant",
  "partial-occluded-history", "fully-hidden-emergence", "camera-loss-recovery",
]);

function checkedPose(value, name) {
  if (!value || ![value.x, value.z].every(Number.isFinite) ||
      (value.heading !== undefined && !Number.isFinite(value.heading)))
    throw new TypeError(`District case requires a finite ${name}`);
  return {
    x: value.x, z: value.z, heading: value.heading ?? 0,
    ...(value.roadId ? { roadId: value.roadId } : {}),
  };
}

function closestWalkline(district, start) {
  return [...(district.walkways ?? [])].sort((a, b) => {
    const gap = (line) => {
      const position = line.axis === "z" ? start.z : start.x;
      const lateral = line.axis === "z" ? start.x : start.z;
      return Math.hypot(lateral - line.fixed,
        Math.max(line.min - position, 0, position - line.max));
    };
    return gap(a) - gap(b);
  })[0];
}

function makePerson(district, anchor, caseId, samples) {
  const start = checkedPose(anchor.actorStart, "actorStart");
  const target = checkedPose(anchor.actorTarget, "actorTarget");
  const line = closestWalkline(district, start);
  const roads = district.drivingRoads ?? district.roads ?? [];
  const road = roads.find((item) => item.id === (start.roadId ?? line?.roadId));
  if (!road || !line)
    throw new RangeError(`District case ${caseId} has no declared actor walkline/road`);
  const person = {
    id: "district-case-person", type: "pedestrian", kind: "man-polo",
    x: start.x, z: start.z,
    heading: caseId === "stationary-curb" ? start.heading
      : Math.atan2(target.x - start.x, target.z - start.z),
    speed: 0, walkSpeed: 1.05 + samples[0] * 0.2,
    radius: 0.34, phase: 0.2 + samples[1] * 0.1,
    distance: 0, wait: 0, pause: 0, reason: "waiting",
    road, side: line.side, along: line.axis === "z" ? start.z : start.x,
    crossing: CROSSING_CASES.has(caseId),
    target: { x: target.x, z: target.z }, walkRoute: null,
    motionMode: "ambient", accelerationMps2: 0, motionTimeS: 0,
    district: {
      caseId, pattern: caseId === "stationary-curb" ? "stationary"
        : caseId === "parallel-away" ? "parallel" : "crossing",
      caseStage: "waiting", stage: "waiting", yieldAtCurb: !CROSSING_CASES.has(caseId),
      holdAtTarget: true, routeConstrained: true, observedDistanceM: 0,
      walkwayId: line.id, origin: { x: start.x, z: start.z },
      destination: { x: target.x, z: target.z },
      intermediate: {
        x: start.x + (target.x - start.x) * 0.38,
        z: start.z + (target.z - start.z) * 0.38,
      },
      hesitationS: 0.45 + samples[2] * 0.35,
      triggerEgoAlongM: anchor.triggerEgoAlongM,
      triggers: [],
    },
  };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  for (const [name, point] of [["start", person], ["target", target]])
    if (!walkSegmentClear(person, point, point, district.statics ?? [], 0.12))
      throw new RangeError(`District case ${caseId} actor ${name} intersects a registered static`);
  return person;
}

function makeTraffic(district, anchor, requestedSpeedMps) {
  const caseId = anchor.matrixCase ?? anchor.id;
  const loading = caseId === "queue-alternate-route";
  const loadingRoad = loading
    ? district.drivingRoads?.find((road) => road.id === "entry-local") : null;
  return (anchor.traffic ?? []).map((item, index) => {
    const service = loading && index === 0;
    const start = checkedPose(service && loadingRoad ? {
      ...districtRoadPose(loadingRoad, loadingRoad.min + 15.5),
      roadId: loadingRoad.id,
    } : item.start, "traffic start");
    const goal = checkedPose(item.goal, "traffic goal");
    return {
      id: item.id ?? `district-case-traffic-${index}`, type: "vehicle",
      kind: item.kind ?? "sedan", ...start, goal,
      speed: 0, steer: 0, length: VEHICLE.length, width: VEHICLE.width,
      maxSpeed: requestedSpeedMps, spec: null, path: [], cursor: 0,
      distance: 0, wait: 0, reason: "ready", phase: 0.5, reckless: false,
      district: {
        caseId, profile: "ordinary", headwayS: 1.6,
        nextLoadingDistanceM: service ? 5 : null, loadingUntilTick: null,
        reroutedTicket: null, goal: { ...goal },
        allowReroute: loading,
        ...(service ? { loadingEnabled: true, loadingOnce: true, loadingDurationS: 10 } : {}),
      },
    };
  });
}

/** Construction only. Empty twins draw the same samples and leave the profile untouched. */
export function createDistrictCase(district, caseId = "ambient", seed = "") {
  if (!DISTRICT_CASES.some((item) => item.id === caseId))
    throw new RangeError(`Unknown district case: ${String(caseId)}`);
  if (caseId === "ambient") return null;
  const anchor = district.caseAnchors?.find((item) => item.matrixCase === caseId || item.id === caseId);
  if (!anchor) throw new RangeError(`District profile has no anchor for ${caseId}`);
  const playerStart = checkedPose(anchor.playerStart, "playerStart");
  const route = district.showcaseRoutes?.find((item) => item.id === anchor.routeId);
  const goal = checkedPose(anchor.goal ?? route?.goal, "goal");
  if (!Number.isFinite(anchor.triggerEgoAlongM) || anchor.triggerEgoAlongM < 0)
    throw new RangeError(`District case ${caseId} has no nonnegative ego-distance trigger`);
  const rng = new Random(`${String(seed)}:district-case-v1`);
  const samples = Array.from({ length: 4 }, () => rng.next());
  const requestedSpeedMps = Number.isFinite(anchor.requestedSpeedMps)
    ? Math.max(0, Math.min(4.5, anchor.requestedSpeedMps)) : 4.5;
  const traffic = makeTraffic(district, anchor, requestedSpeedMps);
  if (["two-car-narrow-passage", "queue-alternate-route"].includes(caseId) && !traffic.length)
    throw new RangeError(`District traffic case ${caseId} needs construction-time opposing traffic`);
  return {
    id: caseId, playerStart, goal, people: EMPTY_CASES.has(caseId)
      ? [] : [makePerson(district, anchor, caseId, samples)],
    traffic, requestedSpeedMps, triggerEgoAlongM: anchor.triggerEgoAlongM,
    allowReroute: caseId === "queue-alternate-route",
    phase: "ready", startedTick: null,
    anchorId: anchor.id, occluderId: anchor.occluderId ?? null,
    waitingZoneId: anchor.waitingZoneId ?? null,
    emptyTwin: anchor.emptyTwin ?? null, caseRngState: rng.state,
    triggeredTick: null, triggerObservedAlongM: null,
    populationLabel: "clean construction-time district fixture; not the 28/32 ambient workload",
  };
}

function recordTrigger(world, person, trigger, details = {}) {
  const entry = {
    tick: world.tick, trigger, x: person.x, z: person.z,
    speedMps: person.speed, acceptedDistanceM: person.distance, ...details,
  };
  person.district.triggers.push(entry);
  if (person.district.triggers.length > 16) person.district.triggers.shift();
}

/** World-side intentions only; the rendered camera remains the perception boundary. */
export function advanceDistrictCase(world, person) {
  if (world.environment !== "egypt" || world.districtCase?.phase !== "running" ||
      !person.district?.caseId)
    return { ...person };
  const working = {
    ...person, target: { ...person.target },
    walkRoute: person.walkRoute?.map((point) => ({ ...point })) ?? null,
    district: {
      ...person.district,
      origin: { ...person.district.origin },
      destination: { ...person.district.destination },
      intermediate: { ...person.district.intermediate },
      triggers: [...person.district.triggers],
    },
  };
  const state = working.district, fixture = world.districtCase;
  const start = fixture.playerStart;
  const egoAlongM = (world.player.x - start.x) * Math.sin(start.heading) +
    (world.player.z - start.z) * Math.cos(start.heading);
  let hold = state.caseId === "stationary-curb";
  if (state.caseStage === "waiting") {
    hold = true;
    if (egoAlongM >= fixture.triggerEgoAlongM) {
      state.caseStage = hold && state.caseId === "stationary-curb" ? "stationary" : "moving";
      fixture.triggeredTick ??= world.tick;
      fixture.triggerObservedAlongM ??= egoAlongM;
      recordTrigger(world, working, "actual-ego-approach-distance", {
        egoAlongM, thresholdM: fixture.triggerEgoAlongM,
      });
      if (state.caseId === "diagonal-hesitant")
        working.target = { ...state.intermediate };
      hold = state.caseId === "stationary-curb";
    }
  }
  if (state.caseStage === "moving" && state.caseId === "diagonal-hesitant" &&
      !state.hesitated && distance(working, state.intermediate) < 0.3 && working.speed < 0.08) {
    state.hesitated = true;
    state.caseStage = "hesitating";
    state.holdUntilTick = world.tick + Math.ceil(state.hesitationS / STEP);
    working.walkRoute = null;
    recordTrigger(world, working, "accepted-intermediate-arrival");
  }
  if (state.caseStage === "hesitating") {
    hold = world.tick < state.holdUntilTick;
    if (!hold) {
      state.caseStage = "moving";
      working.target = { ...state.destination };
      working.walkRoute = null;
      recordTrigger(world, working, "bounded-hesitation-complete", {
        holdS: state.hesitationS,
      });
    }
  }
  if (state.caseStage === "moving" &&
      (state.caseId !== "diagonal-hesitant" || state.hesitated) &&
      distance(working, state.destination) < 0.3 && working.speed < 0.08) {
    state.caseStage = "complete";
    recordTrigger(world, working, "accepted-destination-arrival");
  }
  if (["complete", "stationary", "waiting"].includes(state.caseStage)) hold = true;
  state.stage = state.caseStage;
  const requestedMode = working.motionMode;
  if (hold) working.motionMode = "stop";
  const proposal = stepDistrictPedestrian(world, working);
  proposal.motionMode = requestedMode;
  if (hold && proposal.reason !== "blocked") proposal.reason = `district-${state.caseStage}`;
  return proposal;
}
