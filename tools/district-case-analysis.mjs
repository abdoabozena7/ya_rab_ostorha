// Post-run verification only. Nothing here supplies observations or commands to World.
import { createHash } from "node:crypto";
export const DISTRICT_CASE_IDS = Object.freeze([
  "visible-left", "visible-right", "diagonal-hesitant", "partial-occluded-history",
  "fully-hidden-emergence", "same-occluder-empty", "stationary-curb", "parallel-away",
  "blind-corner-empty", "two-car-narrow-passage", "queue-alternate-route", "camera-loss-recovery",
]);
export const DISTRICT_CASE_ORACLE_VERSION = 1;

const EPS = 1e-8, STEP = 1 / 60;
const finite = Number.isFinite;
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const time = (sample) => sample.timeS ?? sample.tick / 60;
const angle = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const actors = (sample) => [sample.player, ...(sample.traffic ?? []), ...(sample.people ?? [])].filter(Boolean);
const key = (streamId, frameId) => JSON.stringify([streamId, frameId]);
const pixelSource = (value) => ["camera-pixels", "both"].includes(value);
const zero = (value) => finite(value) && Math.abs(value) <= EPS;
const lateral = (point, origin) => (point.x - origin.x) * Math.cos(origin.heading)
  - (point.z - origin.z) * Math.sin(origin.heading);
const forward = (point, origin) => (point.x - origin.x) * Math.sin(origin.heading)
  + (point.z - origin.z) * Math.cos(origin.heading);
const atGoal = (car, goal) => goal && gap(car, goal) <= .8 + EPS
  && Math.abs(angle(car.heading, goal.heading)) <= .2 + EPS && Math.abs(car.speed) <= .05 + EPS;
const canonical = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item;
});

function collector() {
  const checks = [];
  return {
    checks,
    add(id, passed, measured = null) { checks.push({ id, passed: Boolean(passed), measured }); },
    finish(metrics) {
      return { oracleVersion: DISTRICT_CASE_ORACLE_VERSION,
        passed: checks.length > 0 && checks.every((check) => check.passed), checks, metrics,
        violations: checks.filter((check) => !check.passed).map((check) => check.id) };
    },
  };
}

function cameraStop(sample) {
  const s = sample.player.sources, v = s?.visual;
  return pixelSource(s?.appliedSource) && v?.source === "camera-pixels"
    && v.available === true && v.state === "stop" && zero(v.targetSpeedMps)
    && finite(v.ageMs) && v.ageMs <= 750 + EPS && v.evidenceTrackId != null
    && s.requestedMps > .05 && s.behaviorMps > .05
    && zero(s.composedMps) && zero(s.finalMps)
    && (s.map?.targetSpeedMps == null || s.map.targetSpeedMps > 0);
}

export function observeDistrictCrossing(samples, { playerStart, playerWidthM, actorId, observations = null } = {}) {
  if (!samples.length || !playerStart || !finite(playerWidthM))
    return { crossed: false, stopBeforeEntry: false, firstStopS: null, firstLaneEntryS: null };
  actorId ??= samples[0].people?.[0]?.id;
  const poses = samples.map((sample) => ({
    sample, person: sample.people?.find((person) => person.id === actorId),
  })).filter((item) => item.person);
  if (!poses.length)
    return { crossed: false, stopBeforeEntry: false, firstStopS: null, firstLaneEntryS: null };
  const initialSide = Math.sign(lateral(poses[0].person, playerStart));
  const halfLane = playerWidthM / 2 + (poses[0].person.radius ?? 0);
  const entry = poses.find(({ person }) => Math.abs(lateral(person, playerStart)) <= halfLane + EPS);
  const cleared = entry && poses.find(({ sample, person }) => time(sample) > time(entry.sample)
    && initialSide * lateral(person, playerStart) < -halfLane - EPS);
  const byKey = new Map((observations ?? []).map((item) => [item.key, item]));
  const seen = (observations ?? []).filter((item) => item.matchedPerson);
  const supportedStop = (sample) => cameraStop(sample) && (!observations
    || hasSeenHistory(byKey.get(key(sample.player.sources.visual.streamId,
      sample.player.sources.visual.frameId)), seen, sample.player.sources.visual.evidenceTrackId));
  let episode = null, actualStop = null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!supportedStop(sample)) { episode = null; continue; }
    if (!episode) episode = { onsetS: sample.decisionTimeS ?? time(sample),
      moving: Math.abs((samples[i - 1] ?? sample).player.speed) > .05 };
    if (episode.moving && zero(sample.player.speed) && !actualStop) {
      const heldThroughEntry = entry && time(sample) < time(entry.sample) - EPS
        && samples.filter((item) => time(item) >= time(sample)
          && time(item) <= time(entry.sample)).every((item) => zero(item.player.speed) && supportedStop(item));
      if (heldThroughEntry)
        actualStop = { ...episode, timeS: time(sample), tick: sample.tick };
    }
  }
  const reactive = samples.find((sample) => {
    const s = sample.player.sources;
    return s?.appliedSource === "physical-guard" && s.finalMps < s.composedMps - .05;
  });
  const firstLaneEntryS = entry ? time(entry.sample) : null;
  const firstReactiveBrakeS = reactive ? reactive.decisionTimeS ?? time(reactive) : null;
  return {
    actorId, initialSide, halfLaneM: halfLane,
    crossed: Boolean(initialSide && entry && cleared),
    firstLaneEntryS, farSideClearS: cleared ? time(cleared.sample) : null,
    firstStopS: actualStop?.timeS ?? null, stopOnsetS: actualStop?.onsetS ?? null,
    firstReactiveBrakeS,
    stopBeforeEntry: Boolean(actualStop && entry && actualStop.timeS < firstLaneEntryS - EPS
      && (firstReactiveBrakeS === null || actualStop.timeS < firstReactiveBrakeS - EPS)),
  };
}

function insideBody(point, body, margin = 0) {
  return Math.abs(lateral(point, body)) <= body.width / 2 + margin
    && Math.abs(forward(point, body)) <= body.length / 2 + margin;
}

function occupies(car, zone) {
  const dx = car.x - (zone.minX + zone.maxX) / 2;
  const dz = car.z - (zone.minZ + zone.maxZ) / 2;
  const hx = (zone.maxX - zone.minX) / 2, hz = (zone.maxZ - zone.minZ) / 2;
  const sine = Math.sin(car.heading), cosine = Math.cos(car.heading);
  return Math.abs(dx) <= hx + Math.abs(cosine) * car.width / 2 + Math.abs(sine) * car.length / 2
    && Math.abs(dz) <= hz + Math.abs(sine) * car.width / 2 + Math.abs(cosine) * car.length / 2
    && Math.abs(dx * cosine - dz * sine) <= car.width / 2 + hx * Math.abs(cosine) + hz * Math.abs(sine)
    && Math.abs(dx * sine + dz * cosine) <= car.length / 2 + hx * Math.abs(sine) + hz * Math.abs(cosine);
}

function pointSegment(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
  const t = length2 ? Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2)) : 0;
  return { distanceM: gap(point, { x: a.x + dx * t, z: a.z + dz * t }), t };
}

function distanceToPath(point, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++)
    best = Math.min(best, pointSegment(point, points[i - 1], points[i]).distanceM);
  return best;
}

function pathFor(run, car) {
  return run.paths?.find((item) => item.actorId === car.id && item.revision === car.pathRevision)?.points ?? [];
}

function segmentZoneEntry(segment, car, zone, from) {
  const c = Math.cos(segment.heading), s = Math.sin(segment.heading);
  const hx = (zone.maxX - zone.minX) / 2, hz = (zone.maxZ - zone.minZ) / 2;
  const x = segment.a.x - (zone.minX + zone.maxX) / 2;
  const z = segment.a.z - (zone.minZ + zone.maxZ) / 2;
  const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
  const axes = [
    [1, 0, hx + Math.abs(c) * car.width / 2 + Math.abs(s) * car.length / 2],
    [0, 1, hz + Math.abs(s) * car.width / 2 + Math.abs(c) * car.length / 2],
    [c, -s, car.width / 2 + hx * Math.abs(c) + hz * Math.abs(s)],
    [s, c, car.length / 2 + hx * Math.abs(s) + hz * Math.abs(c)],
  ];
  let enter = from, leave = 1;
  for (const [ax, az, extent] of axes) {
    const position = ax * x + az * z, delta = ax * dx + az * dz;
    if (Math.abs(delta) <= EPS) {
      if (Math.abs(position) > extent) return null;
    } else {
      const a = (-extent - position) / delta, b = (extent - position) / delta;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return null;
    }
  }
  return enter;
}

function pathApproachDistance(car, points, zone) {
  if (occupies(car, zone)) return 0;
  let closest = null, length = 0;
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], size = gap(a, b);
    if (size <= EPS) continue;
    const projection = pointSegment(car, a, b), arc = length + projection.t * size;
    if (!closest || projection.distanceM < closest.distanceM)
      closest = { distanceM: projection.distanceM, arc };
    segments.push({ a, b, size, arc: length, heading: Math.atan2(b.x - a.x, b.z - a.z) });
    length += size;
  }
  if (!closest || closest.distanceM > 2) return Infinity;
  for (const segment of segments) {
    if (segment.arc + segment.size < closest.arc) continue;
    const from = Math.max(0, (closest.arc - segment.arc) / segment.size);
    const entry = segmentZoneEntry(segment, car, zone, from);
    if (entry !== null) return Math.max(0, segment.arc + entry * segment.size - closest.arc);
  }
  return Infinity;
}

function blockedCycle(sample) {
  const edges = new Map(), cars = [sample.player, ...(sample.traffic ?? [])];
  const owners = sample.resources?.reservations ?? {};
  for (const car of cars) {
    if (Math.abs(car.speed) > .05) continue;
    const blockedBy = car.blockedBy ?? sample.resources?.holds?.[car.id]?.blockedBy;
    const owner = owners[blockedBy]?.ownerId ?? blockedBy;
    if (owner && owner !== car.id) edges.set(car.id, owner);
  }
  for (const id of edges.keys()) {
    const visited = new Set();
    let node = id;
    while (edges.has(node)) {
      if (visited.has(node)) return true;
      visited.add(node); node = edges.get(node);
    }
  }
  return false;
}

function rayHits(camera, point, box) {
  const origin = { x: lateral(camera.position, box), y: camera.position.y,
    z: forward(camera.position, box) };
  const end = { x: lateral(point, box), y: point.y, z: forward(point, box) };
  const bounds = { x: [-box.width / 2, box.width / 2], y: [0, box.height],
    z: [-box.length / 2, box.length / 2] };
  let enter = 0, leave = 1;
  for (const axis of ["x", "y", "z"]) {
    const direction = end[axis] - origin[axis], [low, high] = bounds[axis];
    if (Math.abs(direction) <= EPS) {
      if (origin[axis] < low || origin[axis] > high) return false;
    } else {
      const a = (low - origin[axis]) / direction, b = (high - origin[axis]) / direction;
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      if (leave < enter) return false;
    }
  }
  return enter > EPS && enter < 1 - EPS && leave >= enter;
}

function project(camera, point) {
  const pose = { x: camera.position.x, z: camera.position.z, heading: camera.headingRad };
  const depth = forward(point, pose);
  if (!(depth > .01)) return null;
  const focal = camera.height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360));
  return { x: camera.width / 2 - lateral(point, pose) * focal / depth,
    y: camera.height / 2 - (point.y - camera.position.y) * focal / depth };
}

function sampleAt(samples, atS) {
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (time(samples[middle]) < atS - EPS) low = middle + 1; else high = middle;
  }
  return samples[low] && Math.abs(time(samples[low]) - atS) <= STEP + EPS ? samples[low] : null;
}

function visibility(camera, person, occluder) {
  if (!camera?.position || !finite(person?.heightM) || !finite(person.radius))
    return null;
  const points = [];
  for (const side of [-1, 0, 1]) for (const height of [.15, .5, 1]) {
    points.push({ x: person.x + Math.cos(camera.headingRad) * person.radius * side,
      y: (camera.groundY ?? 0) + person.heightM * height,
      z: person.z - Math.sin(camera.headingRad) * person.radius * side });
  }
  const projected = points.map((point) => ({ point, pixel: project(camera, point) }));
  const inFrame = projected.filter(({ pixel }) => pixel && pixel.x >= 0 && pixel.x <= camera.width
    && pixel.y >= 0 && pixel.y <= camera.height);
  const hidden = inFrame.filter(({ point }) => occluder && rayHits(camera, point, occluder)).length;
  const pixels = projected.filter(({ pixel }) => pixel).map(({ pixel }) => pixel);
  return { inFrame: inFrame.length, hidden, visible: inFrame.length - hidden,
    fullyHidden: inFrame.length > 0 && hidden === inFrame.length,
    partial: hidden > 0 && hidden < inFrame.length,
    box: pixels.length ? [Math.min(...pixels.map((p) => p.x)), Math.min(...pixels.map((p) => p.y)),
      Math.max(...pixels.map((p) => p.x)), Math.max(...pixels.map((p) => p.y))] : null };
}

function observations(run) {
  const frames = new Map((run.frames ?? []).map((frame) => [frame.key, frame]));
  const occluder = run.geometry?.statics?.find((item) => item.id === run.geometry.occluderId);
  const personId = run.samples[0]?.people?.[0]?.id;
  return (run.observations ?? []).map((observation) => {
    const frame = frames.get(observation.key), result = observation.result;
    const sample = result ? sampleAt(run.samples, result.simulationTimeS) : null;
    const person = sample?.people?.find((item) => item.id === personId);
    const view = person && visibility(frame?.camera, person, occluder);
    const matchedPerson = Boolean(view?.visible > 0 && view.box && result?.detections?.some((d) =>
      d.label === "person" && d.box?.length === 4 && Math.min(d.box[2], view.box[2]) > Math.max(d.box[0], view.box[0])
      && Math.min(d.box[3], view.box[3]) > Math.max(d.box[1], view.box[1])));
    return { ...observation, frame, sample, view, matchedPerson };
  });
}

function sourceChecks(run, observed, out) {
  const byKey = new Map(observed.map((item) => [item.key, item]));
  const faults = [], attribution = [], stale = [], mapFaults = [];
  if (new Set(observed.map((item) => item.key)).size !== observed.length
      || new Set((run.frames ?? []).map((item) => item.key)).size !== (run.frames ?? []).length)
    faults.push("duplicate-frame-or-result-identity");
  for (const observation of observed) {
    const { frame, result } = observation;
    const physical = frame && sampleAt(run.samples, frame.simulationTimeS)?.player;
    const ownPoseMatches = physical && frame.ego && [
      [frame.ego.x, physical.x], [frame.ego.z, physical.z],
      [frame.ego.headingRad, physical.heading], [frame.ego.speedMps, physical.speed],
      [frame.ego.widthM, physical.width], [frame.ego.lengthM, physical.length],
    ].every(([a, b]) => finite(a) && finite(b) && Math.abs(a - b) <= EPS);
    if (!frame || !result || key(result.streamId, result.frameId) !== observation.key
        || frame.key !== observation.key || !/^[a-f0-9]{64}$/i.test(frame.imageSha256 ?? "")
        || !(frame.byteLength > 0) || frame.simulationTimeS !== result.simulationTimeS
        || canonical(frame.ego) !== canonical(result.ego) || canonical(frame.camera) !== canonical(result.camera)
        || !ownPoseMatches || !/yolox/i.test(result.model?.id ?? "")
        || !/^[a-f0-9]{64}$/i.test(result.model?.weightsSha256 ?? ""))
      faults.push(observation.key);
  }
  for (const sample of run.samples.slice(1)) {
    const s = sample.player.sources, v = s?.visual, m = s?.map;
    const atS = sample.decisionTimeS ?? time(sample) - STEP;
    if (!s || ![s.requestedMps, s.behaviorMps, s.composedMps, s.finalMps].every(finite)) {
      attribution.push(sample.tick); continue;
    }
    if (s.finalMps < s.composedMps - .05 && s.appliedSource !== "physical-guard")
      attribution.push(sample.tick);
    if (pixelSource(s.appliedSource) && (!v || v.source !== "camera-pixels"
        || !finite(v.targetSpeedMps) || Math.abs(s.finalMps - s.composedMps) > EPS
        || v.targetSpeedMps > s.behaviorMps + EPS
        || v.targetSpeedMps > (m?.targetSpeedMps ?? Infinity) + EPS))
      attribution.push(sample.tick);
    if (s.appliedSource === "static-map" && (m?.source !== "static-map"
        || !finite(m.targetSpeedMps) || m.targetSpeedMps <= 0
        || Math.abs(s.finalMps - s.composedMps) > EPS))
      attribution.push(sample.tick);
    if (v?.available) {
      const observation = byKey.get(key(v.streamId, v.frameId));
      if (!observation?.result || !finite(v.ageMs) || v.ageMs > 750 + EPS
          || !Number.isInteger(observation.observedTick) || observation.observedTick > sample.tick
          || observation.result.simulationTimeS > atS + EPS
          || v.ageMs + EPS < (atS - observation.result.simulationTimeS) * 1000)
        stale.push(sample.tick);
      if (["stop", "slow", "caution"].includes(v.state) &&
          !observation?.visual?.tracks?.some((track) => track.id === v.evidenceTrackId
            && track.source === "camera-pixels"))
        stale.push(sample.tick);
    }
    if (m?.targetSpeedMps != null && (!(m.targetSpeedMps >= 1.5 - EPS)
        || m.source !== "static-map")) mapFaults.push(sample.tick);
    if (m?.available && m.zoneId) {
      const zone = run.geometry?.cautionZones?.find((item) => item.id === m.zoneId);
      const ego = sample.decisionEgo;
      if (!zone || !ego || !finite(m.distanceM)) { mapFaults.push(sample.tick); continue; }
      // Static-zone distances use the map's approach axis, not the car's changing yaw.
      const pose = { x: ego.x, z: ego.z, heading: zone.heading };
      const distance = forward(zone, pose), side = Math.abs(lateral(zone, pose));
      if (Math.abs(angle(ego.headingRad, zone.heading)) > .7 + EPS || side > 4 + EPS
          || distance > zone.approachM + EPS || distance < -zone.clearanceM - EPS
          || Math.abs(distance - m.distanceM) > 1e-6)
        mapFaults.push(sample.tick);
    }
  }
  out.add("exact-pixel-result-model-pairing", observed.length > 0 && faults.length === 0, faults.slice(0, 8));
  out.add("post-guard-source-attribution", attribution.length === 0, attribution.slice(0, 8));
  out.add("fresh-identified-visual-support", stale.length === 0, stale.slice(0, 8));
  out.add("positive-geometric-static-map-not-prediction", mapFaults.length === 0, mapFaults.slice(0, 8));
}

function physicalChecks(run, out) {
  const samples = run.samples, initial = samples[0], ids = actors(initial).map((a) => a.id).sort();
  const failures = [], timing = [], cycles = [], changedGoals = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i], previous = samples[i - 1];
    if (canonical(actors(sample).map((a) => a.id).sort()) !== canonical(ids))
      failures.push({ tick: sample.tick, fault: "actor-set-changed" });
    if ((sample.audit ?? []).length) failures.push({ tick: sample.tick, fault: "audit", errors: sample.audit });
    if (sample.blockingCycles > 0 || sample.behaviorBlockingCycles > 0
        || sample.peakBehaviorBlockingCycles > 0 || blockedCycle(sample)) cycles.push(sample.tick);
    for (const car of [sample.player, ...(sample.traffic ?? [])]) {
      const goal = car.id === initial.player.id ? run.geometry.goal
        : run.geometry.trafficGoals?.find((item) => item.id === car.id)?.goal;
      if (!goal || (car.goal && canonical(car.goal) !== canonical(goal)))
        changedGoals.push({ tick: sample.tick, actorId: car.id });
    }
    if (!previous) continue;
    const dt = time(sample) - time(previous);
    if (sample.tick !== previous.tick + 1 || Math.abs(dt - STEP) > EPS)
      timing.push(sample.tick);
    for (const actor of actors(sample)) {
      const old = actors(previous).find((item) => item.id === actor.id);
      if (!old || !(dt > 0)) continue;
      const moved = gap(actor, old);
      if (![actor.x, actor.z, actor.speed, actor.heading, actor.distance].every(finite)
          || !finite(actor.maxSpeed) || Math.abs(actor.speed) > actor.maxSpeed + EPS
          || moved > actor.maxSpeed * dt + 1e-6
          || Math.abs(actor.distance - old.distance - moved) > 1e-6
          || moved > Math.max(Math.abs(actor.speed), Math.abs(old.speed)) * dt + 1e-6)
        failures.push({ tick: sample.tick, actorId: actor.id, fault: "accepted-motion", moved });
      if (actor.type === "pedestrian" && (
        actor.speed - old.speed > 2.5 * dt + 1e-6
        || (old.speed - actor.speed > 3.5 * dt + 1e-6 && actor.reason !== "blocked")
        || Math.abs(angle(actor.heading, old.heading)) > 3 * dt + 1e-6))
        failures.push({ tick: sample.tick, actorId: actor.id, fault: "ordinary-human-motion" });
    }
  }
  out.add("complete-fixed-step-physical-trace", timing.length === 0 && samples.length > 1, timing.slice(0, 8));
  out.add("constant-actors-bounded-accepted-motion", failures.length === 0, failures.slice(0, 8));
  out.add("original-physical-goals-retained", changedGoals.length === 0, changedGoals.slice(0, 8));
  out.add("no-observed-blocking-cycle", cycles.length === 0, cycles.slice(0, 8));
  const arrival = samples.find((sample) => atGoal(sample.player, run.geometry?.goal));
  out.add("actual-saved-player-goal-arrival", Boolean(arrival)
    && gap(initial.player, run.geometry.goal) > .8, arrival ? { timeS: time(arrival),
      distanceM: gap(arrival.player, run.geometry.goal), speedMps: arrival.player.speed } : null);
}

function hasSeenHistory(observation, seen, trackId = null) {
  return observation?.visual?.tracks?.some((track) => (!trackId || track.id === trackId)
    && track.source === "camera-pixels" && ["person", "motion"].includes(track.label)
    && track.history?.length >= 2 && (() => {
      const actual = track.history.filter((point) => seen.some((item) =>
        item.result.streamId === (track.streamId ?? observation.result.streamId)
        && item.result.frameId === point.frameId
        && Math.abs(item.result.simulationTimeS - point.simulationTimeS) <= EPS));
      return new Set(actual.map((point) => point.frameId)).size >= 2
        && actual.at(-1).simulationTimeS - actual[0].simulationTimeS >= .1 - EPS;
    })());
}

function appliedResponse(samples, observed) {
  const seen = observed.filter((item) => item.matchedPerson);
  const byKey = new Map(observed.map((item) => [item.key, item]));
  let onset = null;
  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i], s = sample.player.sources, v = s?.visual;
    const binds = pixelSource(s?.appliedSource) && v?.available
      && ["caution", "slow", "stop"].includes(v.state)
      && hasSeenHistory(byKey.get(key(v.streamId, v.frameId)), seen, v.evidenceTrackId)
      && s.finalMps < Math.min(s.behaviorMps, s.map?.targetSpeedMps ?? Infinity) - .05;
    if (!binds) { onset = null; continue; }
    onset ??= { timeS: time(samples[i - 1]), speedMps: samples[i - 1].player.speed };
    if (sample.player.speed < onset.speedMps - .05)
      return { onsetS: onset.timeS, observedS: time(sample), fromMps: onset.speedMps, toMps: sample.player.speed };
  }
  return null;
}

function mapTraversal(run) {
  for (const zone of run.geometry?.cautionZones ?? []) {
    const applied = run.samples.find((sample) => sample.player.sources?.map?.zoneId === zone.id
      && ["static-map", "both"].includes(sample.player.sources.appliedSource)
      && sample.player.sources.map.targetSpeedMps >= 1.5 && sample.player.speed > .05);
    if (!applied) continue;
    const pose = { x: zone.x, z: zone.z, heading: zone.heading };
    if (run.samples.some((sample) => forward(sample.player, pose) < -EPS)
        && run.samples.some((sample) => forward(sample.player, pose) > zone.clearanceM))
      return { zoneId: zone.id, appliedAtS: time(applied), speedMps: applied.player.speed,
        mapCapMps: applied.player.sources.map.targetSpeedMps };
  }
  return null;
}

function analyzeNarrow(run, out) {
  const zone = run.geometry?.conflictZones?.find((item) => item.id === run.geometry.waitingZoneId);
  const initial = run.samples[0], cars = [initial.player, ...(initial.traffic ?? [])];
  if (!zone || cars.length !== 2) {
    out.add("two-physical-cars-and-declared-passage", false);
    return null;
  }
  const outcomes = cars.map((car) => {
    const history = run.samples.map((sample) => ({
      sample, car: [sample.player, ...(sample.traffic ?? [])].find((item) => item.id === car.id),
    }));
    const approach = history.find(({ car: pose }) =>
      pathApproachDistance(pose, pathFor(run, pose), zone) <= zone.approachM + EPS);
    const entry = history.find(({ car: pose }) => occupies(pose, zone));
    const exit = entry && history.find(({ sample, car: pose }) =>
      time(sample) > time(entry.sample) && !occupies(pose, zone));
    const goal = car.id === initial.player.id ? run.geometry.goal
      : run.geometry.trafficGoals?.find((item) => item.id === car.id)?.goal;
    const arrival = history.find(({ car: pose }) => atGoal(pose, goal));
    return { actorId: car.id, approachS: approach ? time(approach.sample) : null,
      entryS: entry ? time(entry.sample) : null, exitS: exit ? time(exit.sample) : null,
      approachPose: approach?.car ?? null, entryPose: entry?.car ?? null,
      goalS: arrival ? time(arrival.sample) - time(initial) : null,
      waitS: approach && entry ? time(entry.sample) - time(approach.sample) : null };
  });
  out.add("both-actually-approach-enter-and-clear", outcomes.every((item) =>
    item.approachS !== null && item.entryS !== null && item.exitS !== null), outcomes);
  out.add("opposing-geometric-approaches-within-1.5s", outcomes.every((item) => item.approachPose)
    && Math.abs(outcomes[0].approachS - outcomes[1].approachS) <= 1.5 + EPS
    && Math.abs(angle(outcomes[0].approachPose.heading, outcomes[1].approachPose.heading)) > Math.PI / 2,
  outcomes.map((item) => item.approachS));
  const second = [...outcomes].filter((item) => item.entryS !== null).sort((a, b) => b.entryS - a.entryS)[0];
  out.add("second-physical-approach-wait-at-most-20s", second?.waitS != null && second.waitS <= 20 + EPS,
    second ? { actorId: second.actorId, waitS: second.waitS } : null);
  out.add("both-physical-goals-within-45s", outcomes.every((item) => item.goalS !== null
    && item.goalS <= 45 + EPS), outcomes.map(({ actorId, goalS }) => ({ actorId, goalS })));
  const conflicts = run.samples.filter((sample) =>
    [sample.player, ...(sample.traffic ?? [])].filter((car) => occupies(car, zone)).length > 1);
  out.add("no-conflicting-passage-occupancy", conflicts.length === 0, conflicts.slice(0, 4).map((s) => s.tick));
  return outcomes;
}

function analyzeQueue(run, out) {
  const blocker = (sample, car) => {
    const id = car.blockedBy ?? sample.resources?.holds?.[car.id]?.blockedBy;
    const owner = sample.resources?.reservations?.[id]?.ownerId ?? id;
    if ([sample.player, ...sample.traffic].some((other) => other.id === owner && other.id !== car.id))
      return owner;
    const zone = run.geometry.conflictZones?.find((item) => item.id === id);
    return zone && [sample.player, ...sample.traffic].find((other) =>
      other.id !== car.id && occupies(other, zone))?.id;
  };
  const queued = run.samples.filter((sample) => actors(sample).some((car) => car.type === "vehicle"
    && Math.abs(car.speed) <= .05 && blocker(sample, car)
    && gap(car, car.id === sample.player.id ? run.geometry.goal
      : run.geometry.trafficGoals?.find((item) => item.id === car.id)?.goal ?? car) > .8));
  const held = queued.some((sample, i) => i && time(sample) - time(queued[i - 1]) <= STEP + EPS
    && actors(sample).some((car) => {
      const prior = actors(queued[i - 1]).find((item) => item.id === car.id);
      return blocker(sample, car) && prior && blocker(queued[i - 1], prior) === blocker(sample, car)
        && gap(car, prior) <= .001;
    }));
  out.add("actual-queued-hold-with-blocker", held, queued.length ? {
    firstS: time(queued[0]), lastS: time(queued.at(-1)), samples: queued.length } : null);
  const followed = [];
  for (const path of run.paths ?? []) {
    if (path.points.length < 2) continue;
    const earlier = (run.paths ?? []).filter((item) => item.actorId === path.actorId
      && item.firstTick < path.firstTick && item.points.length >= 2).at(-1);
    if (!earlier) continue;
    const distinctive = path.points.filter((point) => distanceToPath(point, earlier.points) > .5);
    if (!distinctive.length) continue;
    const heldBefore = queued.some((sample) => sample.tick < path.firstTick
      && actors(sample).some((car) => car.id === path.actorId && blocker(sample, car)));
    const driven = run.samples.filter((sample) => sample.tick >= path.firstTick).map((sample) =>
      ({ sample, car: actors(sample).find((item) => item.id === path.actorId) }))
      .filter(({ car }) => car && car.pathRevision === path.revision && car.speed > .05
        && distanceToPath(car, path.points) <= .5 && distanceToPath(car, earlier.points) > .5);
    const goal = path.actorId === run.samples[0].player.id ? run.geometry.goal
      : run.geometry.trafficGoals?.find((item) => item.id === path.actorId)?.goal;
    const arrived = run.samples.some((sample) => {
      const car = actors(sample).find((item) => item.id === path.actorId);
      return sample.tick >= path.firstTick && car && atGoal(car, goal);
    });
    let newOnlyDrivenM = 0;
    for (let i = 1; i < driven.length; i++) {
      if (driven[i].sample.tick === driven[i - 1].sample.tick + 1)
        newOnlyDrivenM += gap(driven[i].car, driven[i - 1].car);
    }
    if (goal && heldBefore && newOnlyDrivenM > .5 && arrived
        && gap(path.points.at(-1), goal) <= .8 && gap(earlier.points.at(-1), goal) <= .8)
      followed.push({ actorId: path.actorId, revision: path.revision,
        newOnlyDrivenM,
        firstNewOnlyS: time(driven[0].sample), originalGoal: goal });
  }
  out.add("changed-route-geometry-actually-followed-to-original-goal", followed.length > 0, followed);
  return followed;
}

function analyzeCameraLoss(run, observed, out) {
  const start = run.faults?.find((event) => event.type === "withhold-start");
  const end = run.faults?.find((event) => event.type === "withhold-end");
  const during = start && end ? run.samples.filter((sample) =>
    time(sample) >= start.timeS && time(sample) <= end.timeS) : [];
  out.add("actual-camera-withholding-while-moving", start && end && end.timeS > start.timeS
    && start.speedMps > .05 && run.faults.some((event) => event.type === "request-blocked"
      && event.timeS >= start.timeS - EPS && event.timeS <= end.timeS + EPS),
  { start, end });
  const aged = during.filter((sample) => (sample.visualAgeMs ?? sample.player.sources?.visual?.ageMs) > 750);
  out.add("over-750ms-evidence-becomes-unavailable", aged.length > 0 && aged.every((sample) =>
    sample.player.sources?.visual?.state === "unavailable" && sample.player.sources.visual.available === false));
  const stopped = during.find((sample) => zero(sample.player.speed)
    && pixelSource(sample.player.sources?.appliedSource)
    && sample.player.sources.visual?.state === "unavailable"
    && zero(sample.player.sources.finalMps) && sample.player.sources.requestedMps > .05
    && sample.player.sources.behaviorMps > .05 && gap(sample.player, run.geometry.goal) > .8);
  out.add("physical-camera-unavailable-stop-not-guard-or-goal", Boolean(stopped), stopped ? time(stopped) : null);
  const decelFaults = [];
  for (let i = 1; i < during.length; i++) {
    const a = during[i - 1], b = during[i], s = b.player.sources;
    if (pixelSource(s?.appliedSource) && s.visual?.state === "unavailable"
        && a.player.speed - b.player.speed > 2 * (time(b) - time(a)) + 1e-6)
      decelFaults.push(b.tick);
  }
  out.add("ordinary-unavailable-deceleration-at-most-2mps2", decelFaults.length === 0, decelFaults.slice(0, 8));
  const after = end ? run.samples.filter((sample) => time(sample) >= end.timeS) : [];
  const retry = run.faults?.find((event) => event.type === "public-retry");
  out.add("actual-public-retry-and-new-camera-stream", retry && retry.oldStreamId
    && retry.newStreamId && retry.oldStreamId !== retry.newStreamId
    && start && end && retry.timeS >= start.timeS && retry.timeS <= end.timeS, retry);
  const released = after.find((sample) => sample.player.sources?.visual?.available
    && (sample.player.sources.visual.targetSpeedMps ?? sample.player.sources.behaviorMps) > EPS);
  const fresh = released ? observed.filter((item) => item.result?.simulationTimeS >= end.timeS
    && item.result.simulationTimeS <= (released.decisionTimeS ?? time(released))
    && item.observedTick <= released.tick
    && item.result.streamId === released.player.sources.visual.streamId) : [];
  const distinct = new Map(fresh.map((item) => [item.key, item.result.simulationTimeS]));
  const times = [...distinct.values()].sort((a, b) => a - b);
  const held = stopped && released && run.samples.filter((sample) =>
    time(sample) >= time(stopped) && time(sample) < time(released)).every((sample) =>
    zero(sample.player.speed) && zero(sample.player.sources?.finalMps));
  out.add("zero-held-until-two-fresh-frames-spanning-0.1s", held && times.length >= 2
    && retry?.newStreamId === released?.player.sources.visual.streamId
    && times.at(-1) - times[0] >= .1 - EPS, { distinctFrames: times.length,
      spanS: times.length ? times.at(-1) - times[0] : null, releasedS: released ? time(released) : null });
  const releaseFaults = [];
  for (let i = 1; i < after.length; i++) {
    const a = after[i - 1], b = after[i];
    const capA = a.player.sources?.visual?.targetSpeedMps ?? a.player.sources?.behaviorMps;
    const capB = b.player.sources?.visual?.targetSpeedMps ?? b.player.sources?.behaviorMps;
    if (finite(capA) && finite(capB) && capB - capA > 2.4 * (time(b) - time(a)) + 1e-6)
      releaseFaults.push(b.tick);
    if (released && time(b) >= time(released) && b.player.sources?.visual?.available
        && b.player.sources.visual.targetSpeedMps === null) break;
  }
  out.add("recovered-cap-release-at-most-2.4mps2", releaseFaults.length === 0, releaseFaults.slice(0, 8));
}

export function analyzeDistrictCase(run) {
  const out = collector();
  out.add("declared-case-family", DISTRICT_CASE_IDS.includes(run.id), run.id);
  if (!Array.isArray(run.samples) || run.samples.length < 2 || !run.geometry?.goal
      || !run.geometry.playerStart || !run.samples.every((sample) => sample.player
        && Array.isArray(sample.people) && Array.isArray(sample.traffic))) {
    out.add("retained-physical-time-series-and-geometry", false);
    return out.finish({ evidenceClass: run.evidenceClass ?? "unspecified" });
  }
  physicalChecks(run, out);
  const observed = observations(run);
  sourceChecks(run, observed, out);
  const seen = observed.filter((item) => item.matchedPerson);
  const seenFrames = new Set(seen.map((item) => item.key)).size;
  const crossing = observeDistrictCrossing(run.samples, { playerStart: run.geometry.playerStart,
    playerWidthM: run.samples[0].player.width, observations: observed });
  const predictiveStops = run.samples.filter((sample) => {
    const s = sample.player.sources;
    return s?.visual?.state === "stop" && zero(s.visual.targetSpeedMps);
  }).length;
  const approach = run.samples.filter((sample) => gap(sample.player, run.geometry.playerStart) >= 6
    && gap(sample.player, run.geometry.goal) >= 8);
  const response = appliedResponse(run.samples, observed);
  const map = mapTraversal(run);
  const metrics = {
    evidenceClass: run.evidenceClass ?? "unspecified", seenFrames, ...crossing,
    predictiveStops, physicalResponse: response, mapTraversal: map,
    approachMinimumSpeedMps: approach.length > 1 ? Math.min(...approach.map((sample) => sample.player.speed)) : null,
    approachSamples: approach.length,
  };
  if (run.driver === "sensors-only") {
    out.add("sensors-only-never-applies-camera-speed-caps", run.samples.slice(1).every((sample) =>
      sample.player.sources?.visual?.targetSpeedMps === null
      && !pixelSource(sample.player.sources?.appliedSource)));
    return out.finish(metrics);
  }
  const isEmpty = ["same-occluder-empty", "blind-corner-empty",
    "two-car-narrow-passage", "queue-alternate-route"].includes(run.id);
  out.add("actual-required-person-population", run.samples.every((sample) =>
    sample.people.length === (isEmpty ? 0 : 1)));
  if (["visible-left", "visible-right"].includes(run.id)) {
    out.add("requested-mirrored-physical-crossing-side",
      crossing.initialSide === (run.id === "visible-left" ? -1 : 1), crossing.initialSide);
    out.add("three-actually-seen-person-frames", seenFrames >= 3, seenFrames);
    out.add("physical-near-side-entry-and-far-side-clearance", crossing.crossed, crossing);
    out.add("complete-zero-visual-stop-before-later-entry-and-guard", crossing.stopBeforeEntry, crossing);
  } else if (["stationary-curb", "parallel-away"].includes(run.id)) {
    out.add("three-actually-seen-negative-person-frames", seenFrames >= 3, seenFrames);
    out.add("no-predictive-crossing-stop", predictiveStops === 0, predictiveStops);
    const first = run.samples[0].people[0], last = run.samples.at(-1).people[0];
    const sameSide = first && run.samples.every((sample) => sample.people[0]
      && Math.sign(lateral(sample.people[0], run.geometry.playerStart)) === Math.sign(lateral(first, run.geometry.playerStart))
      && Math.abs(lateral(sample.people[0], run.geometry.playerStart)) > crossing.halfLaneM);
    out.add("physically-noncrossing-person", sameSide && !crossing.crossed);
    if (run.id === "stationary-curb")
      out.add("actually-stationary-not-unseen-or-walking", first && run.samples.every((sample) =>
        gap(first, sample.people[0]) <= .05 && Math.abs(sample.people[0].speed) <= .05));
    else out.add("actual-parallel-away-displacement", first && last
      && forward(last, run.geometry.playerStart) - forward(first, run.geometry.playerStart) > 1
      && Math.abs(lateral(last, run.geometry.playerStart) - lateral(first, run.geometry.playerStart)) <= .5);
  } else if (["diagonal-hesitant", "partial-occluded-history"].includes(run.id)) {
    out.add("physical-crossing-completes", crossing.crossed, crossing);
    out.add("actual-history-and-camera-led-physical-response", response && seenFrames >= 2
      && seen.some((item) => hasSeenHistory(item, seen)),
    response);
    if (run.id === "diagonal-hesitant") {
      const poses = run.samples.map((sample) => ({ sample, person: sample.people[0] }));
      const first = poses[0].person, last = poses.at(-1).person;
      out.add("actual-diagonal-motion-in-both-axes", first && last
        && Math.abs(lateral(last, run.geometry.playerStart) - lateral(first, run.geometry.playerStart)) > .5
        && Math.abs(forward(last, run.geometry.playerStart) - forward(first, run.geometry.playerStart)) > .5);
      let pause = null, hesitation = null;
      for (let i = 1; i < poses.length; i++) {
        const { sample, person } = poses[i], prior = poses[i - 1].person;
        if (person && prior && zero(person.speed) && gap(person, prior) <= EPS
            && Math.abs(lateral(person, run.geometry.playerStart)) <= crossing.halfLaneM
            && gap(person, first) > .5 && gap(person, last) > .5) {
          pause ??= { timeS: time(poses[i - 1].sample), pose: person };
          if (time(sample) - pause.timeS >= .1 - EPS
              && poses.slice(i + 1).some((item) => item.person.speed > .05 && gap(item.person, pause.pose) > .5))
            hesitation = { startedS: pause.timeS, observedS: time(sample) };
        } else pause = null;
        if (hesitation) break;
      }
      out.add("interior-physical-hesitation-then-resumed-motion", Boolean(hesitation), hesitation);
    } else {
      const partial = observed.filter((item) => item.view?.partial && item.matchedPerson
        && item.sample?.people[0]?.speed > .05);
      out.add("moving-person-actually-partially-occluded-with-history", partial.some((item) =>
        hasSeenHistory(item, seen)),
      partial.map((item) => ({ key: item.key, timeS: item.result.simulationTimeS, view: item.view })));
    }
  } else if (run.id === "fully-hidden-emergence") {
    const hidden = observed.find((item) => item.view?.fullyHidden);
    const emerged = hidden && seen.find((item) => item.result.simulationTimeS > hidden.result.simulationTimeS);
    out.add("registered-occluder-actually-hides-then-person-emerges", Boolean(hidden && emerged),
      { hiddenS: hidden?.result?.simulationTimeS ?? null, cueS: emerged?.result?.simulationTimeS ?? null });
    out.add("actual-emerged-person-crosses-and-clears", crossing.crossed, crossing);
    const firstCueS = seen[0]?.result.simulationTimeS;
    const psychic = run.samples.filter((sample) => {
      const v = sample.player.sources?.visual;
      if (!v?.evidenceTrackId || !["caution", "slow", "stop"].includes(v.state)) return false;
      const track = observed.find((item) => item.key === key(v.streamId, v.frameId))
        ?.visual?.tracks?.find((item) => item.id === v.evidenceTrackId);
      return ["person", "motion"].includes(track?.label)
        && (firstCueS === undefined || (sample.decisionTimeS ?? time(sample)) < firstCueS - EPS);
    });
    out.add("no-person-prediction-before-an-actual-pixel-cue", psychic.length === 0, psychic.map((s) => s.tick));
    out.add("actual-positive-map-caution-not-psychic-prelane-stop", Boolean(map), map);
    out.add("actual-emergence-moves-from-hidden-to-visible", hidden && emerged
      && gap(hidden.sample.people[0], emerged.sample.people[0]) > .05);
  } else if (["same-occluder-empty", "blind-corner-empty"].includes(run.id)) {
    out.add("actual-positive-static-map-caution-and-clearance-traversal", Boolean(map), map);
    out.add("no-predictive-crossing-stop", predictiveStops === 0, predictiveStops);
    if (run.id === "same-occluder-empty")
      out.add("same-registered-occluder-present", run.geometry.statics?.some((item) =>
        item.id === run.geometry.occluderId && item.width > 0 && item.length > 0 && item.height > 0));
  } else if (run.id === "two-car-narrow-passage") metrics.narrow = analyzeNarrow(run, out);
  else if (run.id === "queue-alternate-route") metrics.reroutes = analyzeQueue(run, out);
  else if (run.id === "camera-loss-recovery") analyzeCameraLoss(run, observed, out);
  return out.finish(metrics);
}

function staticGeometry(run) {
  return canonical({ roads: run.geometry?.roads, statics: run.geometry?.statics,
    cautionZones: run.geometry?.cautionZones });
}

export function analyzeDistrictBaseline(predictive, baseline) {
  const out = collector(), p = analyzeDistrictCase(predictive), b = analyzeDistrictCase(baseline);
  const initialActors = (run) => actors(run.samples[0]).map((actor) =>
    Object.fromEntries(["id", "type", "x", "z", "heading", "speed", "width", "length", "radius", "heightM", "maxSpeed"]
      .filter((name) => actor[name] !== undefined).map((name) => [name, actor[name]])));
  out.add("same-initial-actual-ego-and-other-actor-poses", canonical(initialActors(predictive))
    === canonical(initialActors(baseline)));
  out.add("same-case-seed-static-map-start-goal-and-body", predictive.id === baseline.id
    && predictive.seed === baseline.seed && baseline.driver === "sensors-only"
    && staticGeometry(predictive) === staticGeometry(baseline)
    && canonical(predictive.geometry.playerStart) === canonical(baseline.geometry.playerStart)
    && canonical(predictive.geometry.goal) === canonical(baseline.geometry.goal)
    && predictive.samples[0].player.width === baseline.samples[0].player.width
    && predictive.samples[0].player.length === baseline.samples[0].player.length);
  out.add("both-physically-valid-traces", p.passed && b.passed, { predictive: p.violations, baseline: b.violations });
  if (["visible-left", "visible-right"].includes(predictive.id))
    out.add("actual-visual-zero-stop-precedes-same-map-reactive-onset",
      p.metrics.firstStopS !== null && b.metrics.crossed && b.metrics.firstReactiveBrakeS !== null
      && p.metrics.firstStopS < b.metrics.firstReactiveBrakeS - EPS,
    { visualStopS: p.metrics.firstStopS, reactiveOnsetS: b.metrics.firstReactiveBrakeS });
  else {
    out.add("sampled-moving-baseline-and-predictive-approach", b.metrics.approachMinimumSpeedMps > .05
      && p.metrics.approachMinimumSpeedMps !== null,
    { predictive: p.metrics.approachMinimumSpeedMps, baseline: b.metrics.approachMinimumSpeedMps });
    out.add("lookalike-minimum-speed-at-least-0.8-same-map-baseline",
      p.metrics.approachMinimumSpeedMps !== null && b.metrics.approachMinimumSpeedMps > .05
      && p.metrics.approachMinimumSpeedMps >= .8 * b.metrics.approachMinimumSpeedMps - EPS);
  }
  return out.finish({ evidenceClass: predictive.evidenceClass });
}

export function analyzeDistrictHiddenTwin(hidden, empty, { policyIsolation = null } = {}) {
  const out = collector();
  out.add("same-static-map-and-registered-occluder", staticGeometry(hidden) === staticGeometry(empty)
    && hidden.geometry.occluderId === empty.geometry.occluderId);
  out.add("different-actual-hidden-person-presence", hidden.samples[0].people.length === 1
    && empty.samples.every((sample) => sample.people.length === 0));
  out.add("same-initial-ego-goal-body-and-seed-control", hidden.seed === empty.seed
    && canonical(hidden.geometry.playerStart) === canonical(empty.geometry.playerStart)
    && canonical(hidden.geometry.goal) === canonical(empty.geometry.goal)
    && ["x", "z", "heading", "speed", "width", "length"].every((name) =>
      hidden.samples[0].player[name] === empty.samples[0].player[name]));
  out.add("identical-retained-pixels-odom-history-map-have-identical-decisions",
    policyIsolation?.passed === true
      && policyIsolation.metrics?.identicalAllowedInputPairs > 0
      && policyIsolation.metrics?.hiddenAlternativePairs > 0
      && policyIsolation.metrics.binding === policyBinding(hidden),
    { replayPairs: policyIsolation?.metrics?.identicalAllowedInputPairs ?? 0,
      boundary: "Strict replay keeps the exact captured input, including ego, stream/frame IDs, latency and previous state. Separate live trajectories are never treated as identical." });
  out.add("postrun-hidden-and-empty-pixel-causality-chain",
    analyzeDistrictCase(hidden).passed && analyzeDistrictCase(empty).passed);
  return out.finish({ identicalCrossRunInputPairs: 0,
    identicalAllowedInputPairs: policyIsolation?.metrics?.identicalAllowedInputPairs ?? 0 });
}

const withoutState = ({ nextState: _next, ...value }) => value;
const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
function policyBinding(run) {
  return createHash("sha256").update(canonical({
    id: run.id, seed: run.seed, inputs: run.policyInputs,
    frames: (run.frames ?? []).map(({ key, imageSha256, camera, ego }) => ({ key, imageSha256, camera, ego })),
  })).digest("hex");
}

/** Re-executes only the pure public policy, after the run. Never steps or alters World. */
export function analyzeDistrictPolicyIsolation(run, { decide, mapped, compose } = {}) {
  const out = collector(), failures = [], rejected = [], pairs = [], chainFaults = [];
  const inputs = run.policyInputs ?? [];
  const zones = run.geometry?.cautionZones ?? [];
  out.add("retained-exact-actual-policy-inputs", inputs.length > 0);
  if (![decide, mapped, compose].every((fn) => typeof fn === "function")) {
    out.add("actual-strict-pure-policy-exports", false);
    return out.finish({ identicalAllowedInputPairs: 0 });
  }
  const rejects = (id, invoke) => {
    try { invoke(); rejected.push({ id, rejected: false }); }
    catch (error) { rejected.push({ id, rejected: error instanceof TypeError }); }
  };
  for (const record of inputs) {
    const input = deepFreeze(structuredClone(record.input));
    const sample = run.samples?.find((item) => item.tick === record.tick);
    const frame = run.frames?.find((item) => item.key === key(input.visual?.streamId, input.visual?.frameId));
    const observation = run.observations?.find((item) => item.key === frame?.key);
    const trackHistory = (snapshot, atS) => snapshot?.tracks?.map(({ id, source, frameId, history }) => {
      if (atS === undefined) return { id, source, frameId, history };
      // Recompute the exact age-limited suffix for the decision tick, without editing observations.
      const current = history.filter((sample) => atS - sample.simulationTimeS <= .75 + EPS);
      return { id, source, frameId, history: current.length ? current : history.slice(-1) };
    });
    const noFrame = input.visual === null || (input.visual?.available === false
      && input.visual.status !== "ready" && input.visual.frameId === null
      && input.visual.ageMs === null && input.visual.model === null && input.visual.latencyMs === null
      && input.visual.tracks?.length === 0 && input.visual.forecasts?.length === 0);
    const pixelsLinked = noFrame || (frame && observation?.result
      && canonical(trackHistory(input.visual)) === canonical(trackHistory(observation.visual, input.nowS)));
    if (!sample || !pixelsLinked
        || canonical(input.ego) !== canonical(sample.decisionEgo)
        || input.nowS !== sample.decisionTimeS || input.requestedSpeedMps !== sample.player.sources?.behaviorMps
        || (input.visual === null ? null : input.visual?.ageMs) !== sample.visualAgeMs
        || canonical(record.expected) !== canonical({
          visual: sample.player.sources?.visual, map: sample.player.sources?.map,
          composedMps: sample.player.sources?.composedMps,
        }))
      chainFaults.push(record.tick);
    try {
      // Hidden world-reference alternatives deliberately stay OUTSIDE every policy input.
      const captureSample = frame && sampleAt(run.samples ?? [], frame.simulationTimeS);
      const capturedPeople = captureSample?.people ?? [];
      const alternatives = [[], structuredClone(capturedPeople)];
      const replay = alternatives.map((_worldReference) => {
        const visual = decide(structuredClone(input));
        const map = mapped({ zones: structuredClone(zones), ego: structuredClone(input.ego) });
        const command = compose({ targetSpeed: input.requestedSpeedMps }, {
          visual, map, dt: STEP, previousState: structuredClone(input.previousState),
        });
        return { visual: withoutState(visual), map: command.districtSources.map,
          composedMps: command.targetSpeed };
      });
      const expected = { visual: record.expected.visual, map: record.expected.map,
        composedMps: record.expected.composedMps };
      if (canonical(replay[0]) !== canonical(replay[1]) || canonical(replay[0]) !== canonical(expected))
        failures.push({ tick: record.tick, fault: "retained-input-decision-mismatch" });
      else {
        const box = run.geometry?.statics?.find((item) => item.id === run.geometry.occluderId);
        const hidden = capturedPeople.some((person) => visibility(frame.camera, person, box)?.fullyHidden);
        pairs.push({ tick: record.tick, streamId: input.visual?.streamId,
          frameId: input.visual?.frameId, hasCapturedPixels: !noFrame, sameCapturedEgo: !noFrame,
          differentExternalActorTruth: capturedPeople.length > 0, actualCapturedPersonFullyHidden: hidden });
      }
      // Frozen execution catches policy mutation; the returned value must still agree.
      if (canonical(withoutState(decide(input))) !== canonical(replay[0].visual))
        failures.push({ tick: record.tick, fault: "input-mutation-or-nondeterminism" });
    } catch (error) {
      failures.push({ tick: record.tick, fault: "pure-replay-error", message: error.message });
    }
  }
  if (inputs.length) {
    const input = inputs.find((record) => record.input.visual)?.input ?? inputs[0].input;
    for (const name of ["actors", "world", "seed", "districtCase", "map"])
      rejects(`visual-input-${name}`, () => decide({ ...structuredClone(input), [name]: [] }));
    rejects("odometry-private-intent", () => decide({
      ...structuredClone(input), ego: { ...input.ego, privateIntent: "cross" },
    }));
    if (input.visual) rejects("snapshot-actor-truth", () => decide({
      ...structuredClone(input), visual: { ...structuredClone(input.visual), actors: [] },
    }));
    rejects("map-actor-truth", () => mapped({
      zones: structuredClone(zones), ego: structuredClone(input.ego), actors: [],
    }));
    if (zones.length) rejects("static-zone-actor-truth", () => mapped({
      zones: zones.map((zone) => ({ ...zone, hiddenPerson: true })),
      ego: structuredClone(input.ego),
    }));
    rejects("composition-world-truth", () => compose({ targetSpeed: input.requestedSpeedMps }, {
      dt: STEP, previousState: structuredClone(input.previousState), actors: [],
    }));
  }
  out.add("exact-policy-inputs-linked-to-retained-pixels-and-accepted-ticks",
    inputs.length > 0 && chainFaults.length === 0, chainFaults.slice(0, 8));
  out.add("same-captured-pixels-history-odometry-state-map-replay", pairs.length > 0
    && failures.length === 0, { pairs: pairs.length, failures: failures.slice(0, 8) });
  out.add("strict-policy-rejects-truth-and-map-in-visual-boundary",
    rejected.length >= 8 && rejected.every((item) => item.rejected), rejected);
  return out.finish({ identicalAllowedInputPairs: pairs.length,
    hiddenAlternativePairs: pairs.filter((pair) => pair.differentExternalActorTruth
      && pair.actualCapturedPersonFullyHidden).length, pairs, binding: policyBinding(run),
    evidenceClass: "post-run pure-policy replay of actual retained inputs; not a new live scene" });
}
