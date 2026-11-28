import * as THREE from "three";
import { STEP, clamp } from "../core/config.js";
import { createPedestrianBody } from "../core/pedestrian-body.js";

const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;
const cycle = (value) => ((value % 1) + 1) % 1;
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const components = ["getX", "getY", "getZ", "getW"];

function normalizePedestrianBody(actor) {
  const raw = actor?.body;
  if (
    raw &&
    Number.isFinite(raw.walkSpeedMps) && raw.walkSpeedMps > 0 &&
    Number.isFinite(raw.jogSpeedMps) && raw.jogSpeedMps > raw.walkSpeedMps &&
    Number.isFinite(raw.heightM) && raw.heightM > 0 &&
    Number.isFinite(raw.widthM) && raw.widthM > 0 &&
    Number.isFinite(raw.depthM) && raw.depthM > 0 &&
    Number.isFinite(raw.massKg) && raw.massKg > 0 &&
    Number.isFinite(raw.radiusM) && raw.radiusM > 0 &&
    Number.isFinite(raw.maxAccelerationMps2) &&
    Number.isFinite(raw.maxDecelerationMps2) &&
    Number.isFinite(raw.maxTurnRateRadS)
  ) {
    return raw;
  }
  const defaults = createPedestrianBody(actor);
  if (!raw || typeof raw !== "object") return defaults;
  const merged = { ...defaults, ...raw };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (typeof fallback === "number" && (!Number.isFinite(merged[key]) || merged[key] <= 0))
      merged[key] = fallback;
  }
  if (merged.jogSpeedMps <= merged.walkSpeedMps)
    merged.jogSpeedMps = Math.max(defaults.jogSpeedMps, merged.walkSpeedMps + 0.5);
  return merged;
}

function footGeometry(visual) {
  const feet = [], skeletons = new Set();
  visual.traverse((part) => {
    if (!part.isSkinnedMesh) return;
    skeletons.add(part.skeleton);
    const bones = new Set(part.skeleton.bones.flatMap((bone, index) =>
      /foot|toe/i.test(bone.name) ? [index] : []));
    const indices = part.geometry.getAttribute("skinIndex");
    const weights = part.geometry.getAttribute("skinWeight");
    const vertices = [];
    if (indices && weights)
      for (let i = 0; i < indices.count; i++) {
        let weight = 0;
        for (const component of components)
          if (bones.has(indices[component](i))) weight += weights[component](i);
        if (weight > 0.5) vertices.push(i);
      }
    if (vertices.length) feet.push({ part, vertices, matrix: new THREE.Matrix4() });
  });
  return { feet, skeletons };
}

export function createPedestrianRig(visual, animations, initialActor = {}) {
  if (!visual?.isObject3D)
    throw new TypeError("A fitted articulated pedestrian visual is required");
  const clips = {};
  for (const name of ["idle", "walk", "run"]) {
    const clip = animations?.find((item) => item.name.toLowerCase() === name);
    if (!clip?.tracks.length || !Number.isFinite(clip.duration) || clip.duration <= 0)
      throw new TypeError(`The installed pedestrian asset has no usable ${name} clip`);
    clips[name] = clip;
  }
  let walkStrideM = visual.userData.walkStride * visual.scale.x;
  let runStrideM = visual.userData.runStride * visual.scale.x;
  if (
    !Number.isFinite(walkStrideM) || walkStrideM <= 0 ||
    !Number.isFinite(runStrideM) || runStrideM <= 0
  )
    throw new TypeError("Pedestrian source strides and fitted scale are required");
  const { feet, skeletons } = footGeometry(visual);
  if (!feet.length)
    throw new TypeError("The pedestrian asset must have articulated skinned feet");
  const boneCount = new Set([...skeletons].flatMap((skeleton) => skeleton.bones)).size;
  const footVertices = feet.reduce((sum, foot) => sum + foot.vertices.length, 0);
  const mixer = new THREE.AnimationMixer(visual);
  const actions = Object.fromEntries(Object.entries(clips).map(([name, clip]) => {
    const action = mixer.clipAction(clip).play();
    action.setEffectiveTimeScale(0);
    return [name, action];
  }));
  const vertex = new THREE.Vector3(), parentInverse = new THREE.Matrix4();
  let baselineY = visual.position.y;
  let lastScaleX = visual.scale.x;
  let actor = initialActor, disposed = false, first = true;
  let lastTimeS = 0, lastFixedTimeS = 0, lastDistanceM = 0;
  let motionWeight = 0, runBlend = 0, reading;

  function update(nextActor = actor, alpha = 1) {
    if (disposed) return;
    const prevActorId = actor?.id ?? null;
    const nextActorId = nextActor?.id ?? null;
    const actorIdChanged = !first && (
      (prevActorId !== null || nextActorId !== null)
        ? nextActorId !== prevActorId
        : nextActor !== actor
    );
    actor = nextActor;
    const scaleX = visual.scale.x;
    const scaleChanged = !first && Math.abs(scaleX - lastScaleX) > 1e-6;
    if (Number.isFinite(scaleX) && scaleX > 0) {
      const nextWalkStrideM = visual.userData.walkStride * scaleX;
      const nextRunStrideM = visual.userData.runStride * scaleX;
      if (Number.isFinite(nextWalkStrideM) && nextWalkStrideM > 0) walkStrideM = nextWalkStrideM;
      if (Number.isFinite(nextRunStrideM) && nextRunStrideM > 0) runStrideM = nextRunStrideM;
      lastScaleX = scaleX;
    }
    if (actorIdChanged || scaleChanged) baselineY = visual.position.y;
    const body = normalizePedestrianBody(actor);
    const blend = clamp(finite(alpha, 1), 0, 1);
    const distanceM = Math.max(0, finite(actor.distance));
    const fixedTimeS = Math.max(0, finite(actor.motionTimeS));
    const previous = actor.previous;
    const stepDistanceM = previous
      ? Math.hypot(actor.x - previous.x, actor.z - previous.z) : 0;
    const travelled = Math.max(0, distanceM - finite(stepDistanceM) * (1 - blend));
    const timeS = Math.max(0, fixedTimeS - (previous ? (1 - blend) * STEP : 0));
    const speedMps = Math.max(0, finite(actor.speed));
    const renderedSpeed = previous
      ? Math.max(0, finite(previous.speed, speedMps) * (1 - blend) + speedMps * blend)
      : speedMps;
    const targetMotion = smooth(renderedSpeed / 0.35);
    const targetRun = smooth((renderedSpeed - body.walkSpeedMps - 0.1) /
      Math.max(0.35, body.jogSpeedMps - body.walkSpeedMps - 0.1));
    const nonFiniteBlend = !Number.isFinite(motionWeight) || !Number.isFinite(runBlend);
    const rewound = fixedTimeS < lastFixedTimeS - 1e-9 ||
      distanceM < lastDistanceM - 1e-9;
    if (first || rewound || actorIdChanged || nonFiniteBlend) {
      motionWeight = targetMotion;
      runBlend = targetRun;
      lastTimeS = timeS;
    } else {
      const elapsedS = Math.max(0, timeS - lastTimeS);
      motionWeight += (targetMotion - motionWeight) * (1 - Math.exp(-elapsedS * 12));
      runBlend += (targetRun - runBlend) * (1 - Math.exp(-elapsedS * 10));
      if (Math.abs(motionWeight - targetMotion) < 1e-5) motionWeight = targetMotion;
      if (Math.abs(runBlend - targetRun) < 1e-5) runBlend = targetRun;
      lastTimeS = Math.max(lastTimeS, timeS);
    }
    motionWeight = clamp(finite(motionWeight, targetMotion), 0, 1);
    runBlend = clamp(finite(runBlend, targetRun), 0, 1);
    first = false;
    lastFixedTimeS = fixedTimeS;
    lastDistanceM = distanceM;
    const phase = cycle(finite(actor.phase));
    const walkPhase = cycle(travelled / walkStrideM + phase);
    const runPhase = cycle(travelled / runStrideM + phase);
    const weights = {
      idle: 1 - motionWeight,
      walk: motionWeight * (1 - runBlend),
      run: motionWeight * runBlend,
    };
    for (const name of ["idle", "walk", "run"]) {
      const action = actions[name];
      action.setEffectiveWeight(weights[name]);
      action.time = name === "idle" ? phase * Math.min(1, clips.idle.duration) :
        (name === "walk" ? walkPhase : runPhase) * clips[name].duration;
    }
    // Clip time is assigned from accepted travel; the mixer never advances a treadmill clock.
    mixer.update(0);
    visual.parent?.updateWorldMatrix(true, false);
    visual.updateMatrixWorld(true);
    if (visual.parent) parentInverse.copy(visual.parent.matrixWorld).invert();
    else parentInverse.identity();
    let minFootYM = Infinity, maxFootYM = -Infinity;
    for (const { part, vertices, matrix } of feet) {
      matrix.multiplyMatrices(parentInverse, part.matrixWorld);
      for (const index of vertices) {
        part.getVertexPosition(index, vertex).applyMatrix4(matrix);
        minFootYM = Math.min(minFootYM, vertex.y);
        maxFootYM = Math.max(maxFootYM, vertex.y);
      }
    }
    // Ground actual weighted shoe geometry, without changing the shared mesh or skeleton.
    const correctionM = Number.isFinite(minFootYM) ? -minFootYM : 0;
    visual.position.y += correctionM;
    visual.updateMatrixWorld(true);
    for (const skeleton of skeletons) skeleton.update();
    reading = {
      actorId: String(actor.id ?? ""),
      ready: true,
      source: String(visual.userData.source ?? "local articulated human"),
      body: { ...body },
      motion: {
        mode: actor.motionMode ?? "ambient",
        reason: String(actor.reason ?? ""),
        speedMps,
        accelerationMps2: finite(actor.accelerationMps2),
        turnRateRadS: finite(actor.turnRateRadS),
        headingRad: finite(actor.heading),
        distanceM,
        motionTimeS: fixedTimeS,
        clockAvailable: Number.isFinite(actor.motionTimeS),
      },
      gait: {
        renderedDistanceM: travelled,
        walkStrideM, runStrideM, walkPhase, runPhase,
        motionWeight, runBlend,
      },
      clips: Object.fromEntries(Object.entries(actions).map(([name, action]) =>
        [name, { durationS: clips[name].duration, timeS: action.time, weight: weights[name] }])),
      ground: {
        minFootYM: minFootYM + correctionM,
        maxFootYM: maxFootYM + correctionM,
        offsetM: visual.position.y - baselineY,
        footVertices,
      },
      skeletons: skeletons.size,
      bones: boneCount,
    };
  }

  function diagnostics() {
    return {
      ...reading,
      body: { ...reading.body },
      motion: { ...reading.motion },
      gait: { ...reading.gait },
      clips: Object.fromEntries(Object.entries(reading.clips).map(([name, value]) =>
        [name, { ...value }])),
      ground: { ...reading.ground },
      disposed,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    mixer.stopAllAction();
    mixer.uncacheRoot(visual);
  }

  update(initialActor);
  return { update, diagnostics, dispose };
}
