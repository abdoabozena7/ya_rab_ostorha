import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { createPedestrianRig } from "../src/render/pedestrian-rig.js";
import { STEP } from "../src/core/config.js";

const templates = new Map();
const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`);

function template(kind) {
  if (!templates.has(kind))
    templates.set(kind, (async () => {
      const source = readFileSync(new URL(`../assets/models/people/${kind}.glb`, import.meta.url));
      const length = source.readUInt32LE(12);
      const json = JSON.parse(source.subarray(20, 20 + length).toString());
      // Node has no browser image decoder. Keep original GLB geometry/skins/clips;
      // only omit texture bindings from this in-memory geometry-only load.
      json.materials = json.materials.map((material) => ({ name: material.name }));
      const encoded = Buffer.from(JSON.stringify(json));
      const padded = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 32)]);
      const binary = source.subarray(20 + length);
      const glb = Buffer.alloc(20 + padded.length + binary.length);
      glb.writeUInt32LE(0x46546c67, 0);
      glb.writeUInt32LE(2, 4);
      glb.writeUInt32LE(glb.length, 8);
      glb.writeUInt32LE(padded.length, 12);
      glb.writeUInt32LE(0x4e4f534a, 16);
      padded.copy(glb, 20);
      binary.copy(glb, 20 + padded.length);
      return new GLTFLoader().parseAsync(glb.buffer, "");
    })());
  return templates.get(kind);
}

function bounds(root) {
  root.updateMatrixWorld(true);
  root.traverse((part) => {
    if (part.isSkinnedMesh) {
      part.skeleton.update();
      part.computeBoundingBox();
    }
  });
  return new THREE.Box3().setFromObject(root);
}

async function fixture(t, kind = "man-polo", properties = {}) {
  const gltf = await template(kind);
  const actor = {
    id: `rig-${kind}`, type: "pedestrian", kind, phase: 0.25, walkSpeed: 1.4,
    x: 10, z: 20, heading: 0, speed: 0, distance: 0, motionTimeS: 0,
    accelerationMps2: 0, turnRateRadS: 0, ...properties,
  };
  actor.body = createPedestrianBody(actor);
  const visual = clone(gltf.scene);
  const original = bounds(visual).getSize(new THREE.Vector3());
  visual.scale.multiplyScalar(actor.body.heightM / original.y);
  const fitted = bounds(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  const parent = new THREE.Group();
  parent.position.set(actor.x, 0.12, actor.z);
  parent.rotation.y = actor.heading;
  parent.add(visual);
  const rig = createPedestrianRig(visual, gltf.animations, actor);
  t.after(() => rig.dispose());
  const update = (alpha = 1) => {
    parent.position.set(actor.x, 0.12, actor.z);
    parent.rotation.y = actor.heading;
    rig.update(actor, alpha);
  };
  return { actor, visual, parent, rig, update, gltf };
}

function advance(actor, speed = actor.speed) {
  actor.previous = {
    x: actor.x, z: actor.z, heading: actor.heading, speed: actor.speed,
  };
  actor.accelerationMps2 = (speed - actor.speed) / STEP;
  actor.speed = speed;
  const travel = speed * STEP;
  actor.x += Math.sin(actor.heading) * travel;
  actor.z += Math.cos(actor.heading) * travel;
  actor.distance += travel;
  actor.motionTimeS += STEP;
}

function pose(visual) {
  const bones = [];
  visual.traverse((part) => {
    if (part.isBone) bones.push([
      part.name, ...part.position.toArray(), ...part.quaternion.toArray(), ...part.scale.toArray(),
    ]);
  });
  return { y: visual.position.y, bones };
}

function finiteTree(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) finiteTree(child);
}

test("all four installed articulated bodies fit their descriptors and ground actual shoe vertices", async (t) => {
  for (const kind of ["man-polo", "woman-shirt", "man-jacket", "woman-jacket"]) {
    const { actor, visual, parent, rig, update } = await fixture(t, kind);
    let b = bounds(parent);
    const size = b.getSize(new THREE.Vector3());
    close(size.y, actor.body.heightM, 0.03);
    close(size.x, actor.body.widthM, 0.06);
    close(size.z, actor.body.depthM, 0.06);
    assert.ok(size.x <= actor.body.radiusM * 2 + 0.04);
    assert.ok(visual.getObjectByName("Bip01_Head")?.isBone);
    assert.ok(visual.getObjectByName("Bip01_L_Hand")?.isBone);
    let maximumGroundErrorM = 0;
    for (let tick = 0; tick < 96; tick++) {
      advance(actor, tick < 48 ? actor.body.walkSpeedMps : actor.body.jogSpeedMps);
      update();
      b = bounds(parent);
      maximumGroundErrorM = Math.max(maximumGroundErrorM, Math.abs(b.min.y - parent.position.y));
      assert.ok(Math.abs(b.min.y - parent.position.y) < 0.004,
        `${kind}: actual deformed shoe geometry must stay at the support plane`);
      finiteTree(rig.diagnostics());
    }
    const d = rig.diagnostics();
    assert.ok(d.bones >= 80 && d.skeletons > 0 && d.ground.footVertices > 250);
    assert.equal(d.source, "Microsoft Rocketbox / MIT");
    close(d.gait.walkStrideM, visual.userData.walkStride * visual.scale.x);
    assert.doesNotThrow(() => JSON.stringify(d));
    t.diagnostic(JSON.stringify({
      kind, neutralSizeM: size.toArray(), body: actor.body,
      maximumGroundErrorM, footVertices: d.ground.footVertices, bones: d.bones,
    }));
  }
});

test("actual bone gait is a function of accepted distance, not elapsed time or the requested mode", async (t) => {
  const { actor, visual, rig, update } = await fixture(t, "man-polo", { speed: 1.4 });
  const calf = visual.getObjectByName("Bip01_L_Calf");
  const thigh = visual.getObjectByName("Bip01_L_Thigh");
  const initial = calf.quaternion.clone();
  const initialThigh = thigh.quaternion.clone();
  const stride = rig.diagnostics().gait.walkStrideM;
  actor.motionMode = "jog";
  actor.distance = stride / 4;
  actor.z += stride / 4;
  actor.motionTimeS = 2;
  update();
  t.diagnostic(JSON.stringify({
    calfAngleRad: calf.quaternion.angleTo(initial),
    thighAngleRad: thigh.quaternion.angleTo(initialThigh),
    clips: rig.diagnostics().clips,
  }));
  assert.ok(thigh.quaternion.angleTo(initialThigh) > 0.4,
    "the actual support/swing leg must articulate when accepted distance changes");
  assert.equal(rig.diagnostics().clips.run.weight, 0,
    "a requested jog must not run the legs before accepted speed changes");
  actor.distance = stride;
  actor.z += stride * 3 / 4;
  actor.motionTimeS = 4;
  update();
  close(calf.quaternion.angleTo(initial), 0);
  const sameDistancePose = pose(visual);
  actor.motionTimeS = 40;
  update();
  assert.deepEqual(pose(visual), sameDistancePose);
  const gait = rig.diagnostics().gait;
  close(gait.walkPhase, actor.phase);
  close(gait.renderedDistanceM, stride);
});

test("jog and settled idle blend on fixed simulation time; pause cannot advance legs", async (t) => {
  const { actor, visual, rig, update } = await fixture(t);
  for (let tick = 0; tick < 120; tick++) {
    advance(actor, Math.min(actor.body.jogSpeedMps, actor.speed + actor.body.maxAccelerationMps2 * STEP));
    update();
  }
  assert.ok(rig.diagnostics().clips.run.weight > 0.98);
  const paused = pose(visual);
  const pausedReading = rig.diagnostics();
  for (let frame = 0; frame < 60; frame++) update();
  assert.deepEqual(pose(visual), paused);
  assert.deepEqual(rig.diagnostics(), pausedReading);
  actor.motionMode = "stop";
  update();
  assert.ok(rig.diagnostics().clips.run.weight > 0.98);
  for (let tick = 0; tick < 180; tick++) {
    advance(actor, Math.max(0, actor.speed - actor.body.maxDecelerationMps2 * STEP));
    update();
  }
  const settled = pose(visual), reading = rig.diagnostics();
  assert.equal(actor.speed, 0);
  assert.equal(reading.clips.idle.weight, 1);
  assert.equal(reading.clips.walk.weight, 0);
  assert.equal(reading.clips.run.weight, 0);
  for (let tick = 0; tick < 60; tick++) {
    advance(actor, 0);
    update();
  }
  assert.deepEqual(pose(visual), settled);
  close(rig.diagnostics().gait.renderedDistanceM, reading.gait.renderedDistanceM);
});

test("gait interpolates only the last accepted step and replays identical fixed inputs", async (t) => {
  const first = await fixture(t, "woman-shirt", { speed: 1.4 });
  const second = await fixture(t, "woman-shirt", { speed: 1.4 });
  for (let tick = 0; tick < 180; tick++) {
    const speed = tick < 90 ? 1.4 : 2.4;
    for (const f of [first, second]) {
      advance(f.actor, speed);
      f.update(0.25);
      close(f.rig.diagnostics().gait.renderedDistanceM,
        f.actor.distance - speed * STEP * 0.75);
      f.update(0.75);
    }
    assert.deepEqual(pose(first.visual), pose(second.visual));
    assert.deepEqual(first.rig.diagnostics(), second.rig.diagnostics());
  }
});

test("rig disposal owns only mixer state and cannot dispose shared templates or cloned skeletons", async (t) => {
  const first = await fixture(t), second = await fixture(t);
  let disposed = 0;
  const geometries = new Set(), materials = new Set();
  first.visual.traverse((part) => {
    if (!part.isMesh) return;
    geometries.add(part.geometry);
    for (const material of Array.isArray(part.material) ? part.material : [part.material])
      materials.add(material);
    if (part.isSkinnedMesh) {
      const original = part.skeleton.dispose;
      part.skeleton.dispose = () => { disposed++; };
      t.after(() => { part.skeleton.dispose = original; });
    }
  });
  for (const resource of [...geometries, ...materials]) {
    const listener = () => disposed++;
    resource.addEventListener("dispose", listener);
    t.after(() => resource.removeEventListener("dispose", listener));
  }
  first.rig.dispose();
  first.rig.dispose();
  const afterDisposal = pose(first.visual);
  advance(first.actor, 2);
  first.update();
  assert.equal(first.rig.diagnostics().disposed, true);
  assert.deepEqual(pose(first.visual), afterDisposal);
  advance(second.actor, 1.4);
  second.update();
  assert.equal(second.rig.diagnostics().disposed, false);
  assert.equal(disposed, 0);
});

test("missing clips, strides or articulated skin fail explicitly instead of creating proxy people", async (t) => {
  const { gltf } = await fixture(t);
  assert.throws(() => createPedestrianRig(new THREE.Group(), []), /idle clip/);
  const noStride = clone(gltf.scene);
  noStride.userData = {};
  assert.throws(() => createPedestrianRig(noStride, gltf.animations), /strides/);
  const proxy = new THREE.Group();
  proxy.userData = { walkStride: 1.5, runStride: 2.3 };
  assert.throws(() => createPedestrianRig(proxy, gltf.animations), /skinned feet/);
  assert.throws(() => createPedestrianRig(clone(gltf.scene),
    gltf.animations.filter((clip) => clip.name !== "run")), /run clip/);
});
