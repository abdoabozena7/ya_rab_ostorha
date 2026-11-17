export const VISION_CASES = Object.freeze([
  { id: "cross-left", label: "Crossing from left", description: "A visible walker starts across after a short pause." },
  { id: "cross-right", label: "Crossing from right", description: "The mirrored actual crossing, with the same walker and speed." },
  { id: "parallel", label: "Walking along the curb", description: "The same walker moves forward, not into the ego lane." },
  { id: "stationary", label: "Waiting at the curb", description: "The same visible walker remains still." },
  { id: "empty", label: "No walker", description: "The identical road without a pedestrian." },
].map(Object.freeze));

function finite(value, name, min = -100000, max = 100000) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new TypeError(`${name} is outside its finite bounds`);
}

export function createVisionScenario(caseId) {
  if (!VISION_CASES.some((item) => item.id === caseId))
    throw new RangeError(`Unknown visual case: ${String(caseId)}`);
  const side = caseId === "cross-right" ? 1 : -1;
  const start = { x: side * 4.8, z: 0 };
  const crossing = caseId === "cross-left" || caseId === "cross-right";
  const velocity = { x: crossing ? -side * 0.9 : 0, z: caseId === "parallel" ? 0.9 : 0 };
  const destination = crossing ? { x: -side * 6.4, z: 0 }
    : caseId === "parallel" ? { x: start.x, z: 12 } : { ...start };
  const people = caseId === "empty" ? [] : [{
    id: "vision-walker", type: "pedestrian", kind: "man-polo", radius: 0.34,
    ...start, heading: crossing ? -side * Math.PI / 2 : 0,
    speed: 0, walkSpeed: 0.9, phase: 0.25, distance: 0, wait: 0,
    reason: "waiting", target: { ...destination },
    script: {
      type: "vision-linear", elapsedS: 0, onsetS: 0.65,
      velocity, destination,
      evaluation: {
        source: "committed-scenario-motion", sampleIntervalS: 0.1,
        samples: [], droppedSamples: 0,
      },
    },
  }];
  const statics = [-1, 1].flatMap((sideSign) =>
    [-39, -23, -7, 9, 25, 41, 57].map((z, i) => ({
      id: `vision-building-${sideSign < 0 ? "west" : "east"}-${i}`,
      type: "static", kind: "building", x: sideSign * 13, z,
      width: 8, length: 11, height: 10 + (i % 3) * 3, heading: 0,
    })));
  return {
    id: caseId,
    roads: [{ axis: "z", fixed: 0, min: -60, max: 70, width: 10 }],
    statics,
    playerStart: { x: 0, z: -22, heading: 0, speed: 0 },
    people,
    goalZ: 14,
    requestedSpeedMps: 4.5,
  };
}

/** Scenario commands are kept separate from every visual observation boundary. */
export function advanceVisionActor(actor, dt, context = {}) {
  finite(dt, "dt", 0, 0.1);
  if (!actor || actor.type !== "pedestrian" || actor.script?.type !== "vision-linear")
    throw new TypeError("An assigned vision-linear pedestrian is required");
  const script = actor.script;
  for (const key of ["x", "z", "heading", "speed", "distance", "wait", "phase"])
    finite(actor[key], `actor.${key}`);
  finite(script.elapsedS, "elapsedS", 0, 1e9);
  finite(script.onsetS, "onsetS", 0, 5);
  for (const key of ["x", "z"]) {
    finite(script.velocity[key], `velocity.${key}`, -1.5, 1.5);
    finite(script.destination[key], `destination.${key}`, -60, 70);
  }
  if (Math.hypot(script.velocity.x, script.velocity.z) > 1.5)
    throw new TypeError("Scenario walker speed exceeds its physical bound");
  const timeS = context.simulationTimeS ?? context.timeS ?? script.elapsedS;
  finite(timeS, "simulationTimeS", 0, 1e9);
  const samples = [...script.evaluation.samples];
  const last = samples.at(-1);
  if (last && timeS < last.simulationTimeS)
    throw new TypeError("Evaluation time cannot go backwards");
  // Sample the accepted input pose, not the next proposal that World may constrain.
  if (!last || timeS - last.simulationTimeS >= 0.1 - 1e-8)
    samples.push({ simulationTimeS: timeS, x: actor.x, z: actor.z, speedMps: actor.speed });
  const dropped = Math.max(0, samples.length - 320);
  const nextElapsed = script.elapsedS + dt;
  const activeDt = Math.max(0, nextElapsed - Math.max(script.elapsedS, script.onsetS));
  const remaining = Math.hypot(script.destination.x - actor.x, script.destination.z - actor.z);
  const commandedSpeed = Math.hypot(script.velocity.x, script.velocity.z);
  const travel = Math.min(remaining, commandedSpeed * activeDt);
  const moving = travel > 1e-10 && commandedSpeed > 0;
  const x = actor.x + (moving ? script.velocity.x / commandedSpeed * travel : 0);
  const z = actor.z + (moving ? script.velocity.z / commandedSpeed * travel : 0);
  return {
    ...actor, x, z,
    heading: moving ? Math.atan2(script.velocity.x, script.velocity.z) : actor.heading,
    speed: dt > 0 ? travel / dt : 0,
    distance: actor.distance + travel,
    wait: moving ? 0 : actor.wait + dt,
    reason: moving ? "walking" : nextElapsed < script.onsetS ? "waiting" : "standing",
    target: { ...script.destination },
    script: {
      ...script, velocity: { ...script.velocity }, destination: { ...script.destination },
      elapsedS: nextElapsed,
      evaluation: {
        source: "committed-scenario-motion", sampleIntervalS: 0.1,
        samples: samples.slice(-320),
        droppedSamples: script.evaluation.droppedSamples + dropped,
      },
    },
  };
}
