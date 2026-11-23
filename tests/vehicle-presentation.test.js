import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import { createUnifiedTrafficModel, disposeUnifiedTrafficModel } from "../src/render/unified-traffic-model.js";
import { mountVehiclePanel } from "../src/ui/vehicle-panel.js";
import { createVehicleState } from "../src/core/vehicle-state.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { measureVehicleSensors } from "../src/signal_processing/range-sensors.js";

const wheelNames = [
  "wheel-front-left", "wheel-front-right", "wheel-rear-left", "wheel-rear-right",
];
const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${actual} should be within ${tolerance} of ${expected}`);
const makeActor = () => ({
  id: "player", type: "vehicle", x: 0, z: 0, heading: 0,
  length: 4.2, width: 1.85, speed: 0, vehicle: createVehicleState(),
});
function fixture(t, actor = makeActor(), template = null) {
  const rig = createPlayerVehicle(template, actor);
  const parent = new THREE.Group();
  parent.position.set(actor.x, 0.12 + (actor.y ?? 0), actor.z);
  parent.rotation.y = actor.heading;
  parent.add(rig.root);
  rig.update(actor);
  t.after(() => rig.dispose());
  return { rig, actor, parent };
}
function geometryHash(root) {
  const hash = createHash("sha256");
  root.traverse((part) => {
    if (!part.geometry) return;
    for (const name of ["position", "normal", "color"]) {
      const a = part.geometry.attributes[name];
      if (a) hash.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
    }
  });
  return hash.digest("hex");
}

function surfaceTopology(parts) {
  const vertices = new Map(), parents = [], edges = new Map();
  let triangles = 0, degenerate = 0, volume = 0;
  const find = (id) => parents[id] === id ? id : (parents[id] = find(parents[id]));
  const vertexId = (point) => {
    const key = point.toArray().map((n) => Math.round(n * 1e6)).join(":");
    if (!vertices.has(key)) {
      vertices.set(key, vertices.size);
      parents.push(parents.length);
    }
    return vertices.get(key);
  };
  for (const part of parts) {
    part.updateWorldMatrix(true, false);
    const positions = part.geometry.attributes.position, index = part.geometry.index;
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      const points = [0, 1, 2].map((j) => new THREE.Vector3()
        .fromBufferAttribute(positions, index ? index.getX(i + j) : i + j)
        .applyMatrix4(part.matrixWorld));
      const ids = points.map(vertexId);
      if (new THREE.Triangle(...points).getArea() < 1e-10) degenerate++;
      volume += points[0].dot(new THREE.Vector3().crossVectors(points[1], points[2])) / 6;
      for (let j = 0; j < 3; j++) {
        const a = ids[j], b = ids[(j + 1) % 3];
        parents[find(a)] = find(b);
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      triangles++;
    }
  }
  return {
    components: new Set(parents.map((_, i) => find(i))).size,
    euler: vertices.size - edges.size + triangles,
    openEdges: [...edges.values()].filter((count) => count === 1).length,
    nonManifoldEdges: [...edges.values()].filter((count) => count > 2).length,
    degenerate, volume,
  };
}

function frontInterval(part, frame, x, y) {
  const side = part.material.side;
  part.material.side = THREE.DoubleSide;
  const hits = new THREE.Raycaster(
    frame.localToWorld(new THREE.Vector3(x, y, 3)),
    new THREE.Vector3(0, 0, -1).transformDirection(frame.matrixWorld),
  ).intersectObject(part);
  part.material.side = side;
  assert.ok(hits.length, `${part.name} has no surface at ${x}, ${y}`);
  const zs = hits.map((hit) => frame.worldToLocal(hit.point.clone()).z);
  return { front: Math.max(...zs), back: Math.min(...zs) };
}

test("the SUV is synchronous without a template and has real open wheel arches rather than a solid box", (t) => {
  const unreadableTemplate = new Proxy({}, { get() { throw new Error("No imported player model"); } });
  const { rig } = fixture(t, makeActor(), unreadableTemplate);
  assert.equal(typeof rig.then, "undefined");
  const fender = rig.root.getObjectByName("suv-left-front-fender");
  const hole = new THREE.Raycaster(
    new THREE.Vector3(-2, 0.12 + 0.55, 1.3), new THREE.Vector3(1, 0, 0),
  );
  assert.equal(hole.intersectObject(fender).length, 0);
  const upper = new THREE.Raycaster(
    new THREE.Vector3(-2, 0.12 + 1.02, 1.3), new THREE.Vector3(1, 0, 0),
  );
  assert.ok(upper.intersectObject(fender).length > 0);
  const roof = rig.root.getObjectByName("suv-faceted-roof");
  close(new THREE.Box3().setFromObject(roof).max.y, 0.12 + 1.82, 1e-6);
  assert.ok(fender.material.name.includes("paint"));
  assert.ok(fender.material.roughness > 0.85 && fender.material.metalness === 0);
});

test("each faceted arch is one closed joined skin and fills both former exposed-cap notches", (t) => {
  const { rig } = fixture(t);
  for (const [label, side] of [["left", -1], ["right", 1]])
    for (const axle of [-1, 1]) {
      const parts = [];
      rig.root.traverse((part) => {
        if (part.isMesh && (part.name === `suv-${label}-arch-${axle}` ||
            part.name.startsWith(`suv-${label}-arch-${axle}-`))) parts.push(part);
      });
      assert.ok(parts.length);
      const { volume, ...topology } = surfaceTopology(parts);
      assert.deepEqual(topology, {
        components: 1, euler: 2, openEdges: 0, nonManifoldEdges: 0, degenerate: 0,
      }, `${label} axle ${axle}: independently capped rods are not a joined skin`);
      assert.ok(volume > 0, "the closed trim must have outward-facing surfaces");
      for (const [z, y] of [[axle * 1.3 + 0.361, 0.927], [axle * 1.3 + 0.567, 0.666]]) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(side * 2, 0.12 + y, z), new THREE.Vector3(-side, 0, 0),
        );
        assert.ok(ray.intersectObjects(parts, false).length,
          `${label} axle ${axle}: the outside miter must fill the old notch`);
      }
    }
});

test("chunky actual tires roll on neutral X axes, steer on Y and retain road contact under load", (t) => {
  const { rig, actor } = fixture(t);
  for (let i = 0; i < wheelNames.length; i++) {
    const wheel = rig.root.getObjectByName(wheelNames[i]);
    close(wheel.position.x, i % 2 ? 0.775 : -0.775);
    close(wheel.position.y, 0.35);
    close(wheel.position.z, i < 2 ? 1.3 : -1.3);
    const spin = rig.root.getObjectByName(`${wheel.name}-spin`);
    close(spin.quaternion.angleTo(new THREE.Quaternion()), 0);
    const tread = rig.root.getObjectByName(`${wheel.name}-tread`);
    const bounds = new THREE.Box3().setFromObject(tread);
    close(bounds.min.y, 0.12, 1e-6);
    close(bounds.max.y, 0.82, 1e-6);
  }
  actor.vehicle.wheelAngles = { frontLeft: 0.29, frontRight: 0.37 };
  actor.vehicle.wheelSpinRad = Math.PI / 2;
  actor.vehicle.suspension.pitchRad = 0.04;
  actor.vehicle.suspension.rollRad = -0.03;
  actor.vehicle.suspension.heaveM = -0.02;
  rig.update(actor);
  const spin = rig.root.getObjectByName("wheel-front-right-spin");
  const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(
    spin.getWorldQuaternion(new THREE.Quaternion()),
  );
  close(axis.x, Math.cos(0.37)); close(axis.y, 0); close(axis.z, -Math.sin(0.37));
  for (const name of wheelNames)
    close(rig.root.getObjectByName(name).getWorldPosition(new THREE.Vector3()).y, 0.47);
  close(rig.root.getObjectByName("player-chassis").rotation.x, 0.04);
});

test("signed travel reverses the tire surface but never spins the caliper", (t) => {
  const { rig, actor } = fixture(t);
  const spin = rig.root.getObjectByName("wheel-front-left-spin");
  const caliper = rig.root.getObjectByName("wheel-front-left-brake-pad");
  const before = caliper.getWorldPosition(new THREE.Vector3());
  actor.vehicle.wheelSpinRad = Math.PI / 2;
  rig.update(actor);
  let top = spin.localToWorld(new THREE.Vector3(0, 0.2, 0));
  close(top.z, 1.5); close(top.y, 0.47);
  close(caliper.getWorldPosition(new THREE.Vector3()).distanceTo(before), 0);
  actor.vehicle.wheelSpinRad = -Math.PI / 2;
  rig.update(actor);
  top = spin.localToWorld(new THREE.Vector3(0, 0.2, 0));
  close(top.z, 1.1);
  close(caliper.getWorldPosition(new THREE.Vector3()).distanceTo(before), 0);
});

test("open split-spoke rims expose the real brake disc through the wheel under steering", (t) => {
  const { rig, actor } = fixture(t);
  for (const angle of [0, 0.34, -0.28]) {
    actor.vehicle.wheelAngles = { frontLeft: angle, frontRight: angle };
    actor.vehicle.wheelSpinRad = -0.7;
    rig.update(actor);
    for (const name of wheelNames) {
      const spin = rig.root.getObjectByName(`${name}-spin`);
      const side = name.endsWith("left") ? -1 : 1;
      const local = new THREE.Vector3(side, 0.165 * Math.cos(0.44), 0.165 * Math.sin(0.44));
      const origin = spin.localToWorld(local);
      const direction = new THREE.Vector3(-side, 0, 0)
        .transformDirection(spin.matrixWorld);
      const parts = ["tire", "tread", "rim", "alloy-spokes", "hub", "disc"]
        .map((suffix) => rig.root.getObjectByName(`${name}-${suffix}`));
      const hits = new THREE.Raycaster(origin, direction).intersectObjects(parts, false);
      assert.equal(hits[0]?.object.name, `${name}-disc`,
        "a solid decorative rim must not hide the actual rotor");
      const hub = rig.root.getObjectByName(`${name}-hub`);
      assert.equal(hub.parent, spin, "lug nuts must share signed wheel travel");
      const pad = rig.root.getObjectByName(`${name}-brake-pad`);
      assert.notEqual(pad.parent, spin, "the caliper must not turn with the disc");
    }
  }
});

test("staggered tread has a real centre groove and raised shoulder lugs without widening tires", (t) => {
  const { rig } = fixture(t);
  const spin = rig.root.getObjectByName("wheel-front-left-spin");
  const tire = rig.root.getObjectByName("wheel-front-left-tire");
  const tread = rig.root.getObjectByName("wheel-front-left-tread");
  const top = (x, parts) => {
    const ray = new THREE.Raycaster(
      spin.localToWorld(new THREE.Vector3(x, 1, 0)), new THREE.Vector3(0, -1, 0),
    );
    const hit = ray.intersectObjects(parts, false)[0];
    assert.ok(hit);
    return spin.worldToLocal(hit.point).y;
  };
  assert.ok(top(-0.044, [tire, tread]) - top(0, [tire, tread]) > 0.006);
  assert.ok(top(-0.118, [tread]) - top(-0.118, [tire]) > 0.006);
  tread.geometry.computeBoundingBox();
  assert.ok(tread.geometry.boundingBox.min.x >= -0.125);
  assert.ok(tread.geometry.boundingBox.max.x <= 0.125);
  close(top(-0.044, [tire, tread]), 0.35, 1e-6);
});

test("new lug hardware follows signed rolling and rack yaw, rejecting a disconnected hub", (t) => {
  const { rig, actor } = fixture(t);
  const wheel = rig.root.getObjectByName("wheel-front-left");
  const spin = rig.root.getObjectByName("wheel-front-left-spin");
  const hub = rig.root.getObjectByName("wheel-front-left-hub");
  const vertex = new THREE.Vector3().fromBufferAttribute(hub.geometry.attributes.position, 0);
  const center = wheel.getWorldPosition(new THREE.Vector3());
  const rest = hub.localToWorld(vertex.clone()).sub(center);
  const distanceFromExpected = (travel, yaw) => {
    const c = Math.cos(travel), s = Math.sin(travel);
    const y = rest.y * c - rest.z * s, z = rest.y * s + rest.z * c;
    const expected = new THREE.Vector3(
      rest.x * Math.cos(yaw) + z * Math.sin(yaw), y,
      -rest.x * Math.sin(yaw) + z * Math.cos(yaw),
    ).add(center);
    return hub.localToWorld(vertex.clone()).distanceTo(expected);
  };
  for (const travel of [-0.8, 0.8]) {
    actor.vehicle.wheelSpinRad = travel;
    actor.vehicle.wheelAngles = { frontLeft: 0.31, frontRight: 0.25 };
    rig.update(actor);
    close(distanceFromExpected(travel, 0.31), 0);
  }
  wheel.attach(hub);
  actor.vehicle.wheelSpinRad = -0.8;
  rig.update(actor);
  assert.ok(distanceFromExpected(-0.8, 0.31) > 0.03,
    "a hub detached from the rolling assembly must fail the actual vertex-motion oracle");
  spin.add(hub);
  hub.position.set(0, 0, 0); hub.quaternion.identity(); hub.scale.set(-1, 1, 1);
  rig.update(actor);
  close(distanceFromExpected(-0.8, 0.31), 0);
});

test("detailed rolling hardware shares owned buffers and each shared allocation is released once", () => {
  const rig = createPlayerVehicle(null, makeActor());
  const resources = new Set(), counts = new Map();
  for (const suffix of ["tire", "tread", "disc", "rim", "alloy-spokes", "hub", "brake-ports"]) {
    const parts = wheelNames.map((name) => rig.root.getObjectByName(`${name}-${suffix}`));
    assert.ok(parts.every((part) => part.geometry === parts[0].geometry));
    resources.add(parts[0].geometry);
  }
  for (const geometry of resources) {
    counts.set(geometry, 0);
    geometry.addEventListener("dispose", () => counts.set(geometry, counts.get(geometry) + 1));
  }
  rig.dispose(); rig.dispose();
  assert.ok([...counts.values()].every((count) => count === 1));
});

test("traffic's relief rims stay inside the original wheel envelope and follow signed articulation", () => {
  const { root, wheels } = createUnifiedTrafficModel({ kind: "suv", width: 1.85, length: 4.2 });
  try {
    assert.equal(root.children.filter((part) => part.isMesh).length, 5,
      "detail must not add per-traffic draw calls");
    const { geometry } = wheels[0].part;
    assert.ok(wheels.every(({ part }) => part.geometry === geometry));
    const bounds = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
    const radius = wheels[0].radius, thickness = bounds.max.x * 2;
    close(bounds.max.y, radius, 1e-6);
    close(bounds.min.y, -radius, 1e-6);
    const outwardNormals = geometry.attributes.normal, positions = geometry.attributes.position;
    let insetHubFaces = 0;
    for (let i = 0; i < positions.count; i++) {
      const radial = Math.hypot(positions.getY(i), positions.getZ(i));
      if (radial < radius * 0.01 &&
          Math.abs(positions.getX(i)) < thickness * 0.47) insetHubFaces++;
      if (Math.abs(outwardNormals.getX(i)) > 0.9 && radial < radius * 0.17)
        assert.ok(outwardNormals.getX(i) * positions.getX(i) > 0, "hub faces point outwards");
    }
    assert.ok(insetHubFaces > 10, "spoke recesses must be actual relief, not flat stripes");
    const wheel = wheels[0].part;
    wheel.rotation.set(-0.7, 0.3, 0, "YXZ");
    root.updateWorldMatrix(true, true);
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(wheel.quaternion);
    close(axis.y, 0); close(axis.x, Math.cos(0.3)); close(axis.z, -Math.sin(0.3));
    let disposed = 0;
    geometry.addEventListener("dispose", () => disposed++);
    disposeUnifiedTrafficModel(root); disposeUnifiedTrafficModel(root);
    assert.equal(disposed, 1);
  } finally {
    disposeUnifiedTrafficModel(root);
  }
});

test("supported struts/wishbones follow chassis load while tire centers stay grounded", (t) => {
  const { rig, actor } = fixture(t);
  const spring = rig.root.getObjectByName("wheel-front-left-spring");
  const length = spring.scale.y;
  actor.vehicle.suspension.heaveM = -0.03;
  actor.vehicle.suspension.pitchRad = 0.045;
  actor.vehicle.suspension.rollRad = -0.025;
  actor.vehicle.suspension.wheelOffsetsM.frontLeft = 0.06;
  rig.update(actor);
  assert.ok(Math.abs(spring.scale.y - length) > 0.01);
  const tower = rig.root.getObjectByName("wheel-front-left-strut-tower");
  const top = tower.localToWorld(new THREE.Vector3(0, 0.5, 0));
  const chassisTop = rig.root.getObjectByName("player-chassis")
    .localToWorld(new THREE.Vector3(-0.57, 0.81, 1.3));
  close(top.distanceTo(chassisTop), 0);
  close(rig.root.getObjectByName("wheel-front-left").getWorldPosition(new THREE.Vector3()).y, 0.47);
});

test("the mounted left-hand cockpit consumes actual steering/instruments and rejects a disconnected wheel", (t) => {
  const { rig, actor } = fixture(t);
  const wheel = rig.root.getObjectByName("cockpit-steering");
  const column = rig.root.getObjectByName("cockpit-steering-column");
  assert.equal(wheel.parent.parent, column.parent);
  actor.vehicle.steeringWheelRad = -3.2;
  actor.vehicle.wheelAngles = { frontLeft: -0.26, frontRight: -0.22 };
  actor.speed = -4;
  actor.vehicle.controls = { throttle: 0.4, brake: 0.25, gear: "R" };
  rig.update(actor);
  close(wheel.rotation.z, -3.2);
  const display = rig.root.getObjectByName("cockpit-dashboard");
  assert.deepEqual(display.userData.reading, { speedKmh: -14.4, gear: "R", brake: 0.25 });
  const agrees = () => Math.abs(wheel.rotation.z - actor.vehicle.steeringWheelRad) < 1e-8;
  assert.equal(agrees(), true);
  wheel.rotation.z = 0;
  assert.equal(agrees(), false, "frozen real presentation must fail the rack agreement");
  rig.update(actor);
  assert.equal(agrees(), true);
  const pose = rig.getCameraPose("cockpit");
  close(pose.position.x, -0.36); close(pose.position.y, 1.4);
  pose.position.y = 20;
  close(rig.getCameraPose("cockpit").position.y, 1.4);
});

const localLenses = [
  ["left-outer", -70, -0.76, 0.54, 2.14],
  ["left-inner", -35, -0.43, 0.54, 2.14],
  ["center", 0, 0, 0.54, 2.14],
  ["right-inner", 35, 0.43, 0.54, 2.14],
  ["right-outer", 70, 0.76, 0.54, 2.14],
  ["rear-left", -145, -0.66, 0.58, -2.14],
  ["rear-center", 180, 0, 0.58, -2.14],
  ["rear-right", 145, 0.66, 0.58, -2.14],
  ["side-left", -90, -0.955, 0.64, 0.15],
  ["side-right", 90, 0.955, 0.64, 0.15],
];
test("all ten rendered lenses and beam endpoints agree with independent rotated near-surface oracles", (t) => {
  const actor = makeActor();
  Object.assign(actor, { x: 4, z: -7, heading: 0.71 });
  const { rig } = fixture(t, actor);
  rig.setInspection({ sensors: true });
  const s = Math.sin(actor.heading), c = Math.cos(actor.heading);
  for (const [id, degrees, x, y, z] of localLenses) {
    const origin = new THREE.Vector3(actor.x + x * c + z * s, 0.12 + y, actor.z - x * s + z * c);
    const angle = actor.heading + degrees * Math.PI / 180;
    const direction = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const center = origin.clone().addScaledVector(direction, 6);
    const obstacle = { id: `oracle-${id}`, type: "pedestrian", x: center.x, z: center.z, radius: 0.2, height: 2 };
    const sensors = measureVehicleSensors({ actors: [actor, obstacle], statics: [] }, actor);
    const ray = sensors.rays.find((r) => r.id === id);
    close(ray.rangeM, 5.8, 1e-6);
    assert.equal(ray.hitId, obstacle.id);
    rig.update(actor, sensors);
    const lens = rig.root.getObjectByName(`sensor-range-${id}`);
    close(lens.getWorldPosition(new THREE.Vector3()).distanceTo(origin), 0);
    close(lens.getWorldDirection(new THREE.Vector3()).distanceTo(direction), 0);
    const beam = rig.root.getObjectByName(`sensor-ray-${id}`);
    const p = beam.geometry.attributes.position;
    const start = beam.localToWorld(new THREE.Vector3().fromBufferAttribute(p, 0));
    const end = beam.localToWorld(new THREE.Vector3().fromBufferAttribute(p, 1));
    close(start.distanceTo(origin), 0, 1e-6);
    close(end.distanceTo(origin.clone().addScaledVector(direction, 5.8)), 0, 2e-6);
  }
  assert.equal(rig.diagnostics.sensors.ranges.length, 5);
  assert.equal(rig.diagnostics.sensors.auxiliary.length, 5);
  const telemetry = rig.root.getObjectByName("sensor-roof-imu-gnss");
  const expected = new THREE.Vector3(actor.x - 0.15 * s, 2, actor.z - 0.15 * c);
  close(telemetry.getWorldPosition(new THREE.Vector3()).distanceTo(expected), 0);
});

test("front/rear RGB poses face opposite real lens directions and the spare does not block the rear image", (t) => {
  const { rig } = fixture(t);
  const front = rig.getCameraPose("sensor"), rear = rig.getCameraPose("sensor-rear");
  assert.deepEqual(front.position, { x: 0, y: 1.46, z: 0.72 });
  close(rear.position.z, -2.135);
  const opaque = [];
  rig.root.traverseVisible((part) => {
    if (part.isMesh && !part.material.transparent) opaque.push(part);
  });
  for (const [pose, id, sign] of [[front, "front-camera", 1], [rear, "rear-camera", -1]]) {
    const expected = new THREE.Vector3(0, 0, sign);
    const lens = rig.root.getObjectByName(`sensor-${id}`);
    close(lens.getWorldDirection(new THREE.Vector3()).distanceTo(expected), 0);
    const direction = new THREE.Vector3(
      pose.target.x - pose.position.x, pose.target.y - pose.position.y, pose.target.z - pose.position.z,
    ).normalize();
    close(direction.distanceTo(expected), 0);
    const ray = new THREE.Raycaster(lens.getWorldPosition(new THREE.Vector3()), direction, 0.025, 20);
    assert.equal(ray.intersectObjects(opaque, false).length, 0, `${id} must not look into its own car`);
  }
  const spare = rig.root.getObjectByName("suv-rear-spare");
  assert.ok(new THREE.Box3().setFromObject(spare).max.y < 0.12 + 1.25);
});

test("actual fixture contact deforms painted panels locally and exact repair restores all geometry bytes", (t) => {
  const { rig, actor } = fixture(t);
  const pristineHash = geometryHash(rig.root);
  const fascia = rig.root.getObjectByName("suv-front-fascia");
  const rear = rig.root.getObjectByName("suv-rear-hatch");
  const cabin = rig.root.getObjectByName("suv-cabin-floor");
  const frontOriginal = fascia.geometry.attributes.position.array.slice();
  const rearOriginal = rear.geometry.attributes.position.array.slice();
  const cabinOriginal = cabin.geometry.attributes.position.array.slice();
  rig.update(actor);
  assert.equal(geometryHash(rig.root), pristineHash, "noncontact does not manufacture dents");
  const world = new World({}, "vehicle");
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), true);
  for (let n = 0; n < 400 && world.vehicleTest.phase !== "contact"; n++) world.step();
  assert.equal(world.vehicleTest.phase, "contact");
  actor.vehicle = world.player.vehicle;
  rig.update(actor);
  const p = fascia.geometry.attributes.position;
  let dented = 0;
  for (let i = 0; i < p.count; i++)
    if (p.getZ(i) < frontOriginal[i * 3 + 2] - 0.025) dented++;
  assert.ok(dented > 3, "actual painted front surface needs a localized visible dent");
  assert.deepEqual(rear.geometry.attributes.position.array, rearOriginal);
  assert.deepEqual(cabin.geometry.attributes.position.array, cabinOriginal);
  assert.ok(fascia.geometry.attributes.color.array.some((value) => value < 0.8));
  const damagedHash = geometryHash(rig.root);
  rig.update(actor); rig.update(actor);
  assert.equal(geometryHash(rig.root), damagedHash, "parked contact never rebuilds/cumulates dents");
  actor.vehicle = createVehicleState();
  rig.update(actor);
  assert.equal(geometryHash(rig.root), pristineHash);
});

test("Dispatch renders fresh accepted impact on a stopped SUV without re-denting a latched pair", (t) => {
  const hold = { steer: 0, throttle: 0, brake: 1, gear: 1 };
  const profile = { damageFeedback: "accepted-contact-v1" };
  function trace(feedback = {}, tail = true) {
    const env = new GtaPursuitEnv();
    env.reset({ seed: "metro-impact-feedback-lab", traffic: 0, pedestrians: 0,
      scenario: tail ? "L01" : "L01-control", config: {
        ruleset: "dispatch-v1", wantedLevelStart: 1, maxActivePatrols: Number(tail), ...feedback,
      } });
    const { player, pursuit } = env.world;
    player.speed = 0;
    if (tail) {
      const [patrol] = pursuit.patrols;
      Object.assign(patrol, { x: player.x - 5.6 * Math.sin(player.heading),
        z: player.z - 5.6 * Math.cos(player.heading), speed: 12 });
    }
    const { rig } = fixture(t, player);
    const hatch = rig.root.getObjectByName("suv-rear-hatch").geometry.attributes.position.array;
    const pristine = hatch.slice();
    const drivable = createHash("sha256"), frames = [];
    for (let tick = 1; tick <= 44; tick++) {
      const speedBefore = player.speed, healthBefore = player.health;
      const { obs, reward, info } = env.step(hold, 1);
      rig.update(player, env.world.sensors);
      drivable.update(JSON.stringify({ events: info.events, metrics: pursuit.metrics, reward,
        actors: env.world.actors.map(({ id, x, z, heading, speed, steer, distance, reason, health, gtaSlipMps, gtaYawRate }) =>
          [id, x, z, heading, speed, steer, distance, reason, health, gtaSlipMps, gtaYawRate]) }));
      drivable.update(Buffer.from(obs.buffer, obs.byteOffset, obs.byteLength));
      let hatchInwardM = 0;
      for (let i = 2; i < hatch.length; i += 3)
        hatchInwardM = Math.max(hatchInwardM, hatch[i] - pristine[i]);
      const damage = player.vehicle.damage, rendered = rig.diagnostics.damage;
      frames.push({ tick, speedBefore, speedAfter: player.speed, healthLoss: healthBefore - player.health,
        contact: info.events.find(event => event.type === "patrol_collision"), damage, rendered: { ...rendered }, hatchInwardM });
    }
    return { drivable: drivable.digest("hex"), frames };
  }

  const archived = trace();
  const oldHits = archived.frames.filter(frame => frame.contact);
  assert.deepEqual(oldHits.map(({ tick, contact }) => [tick, contact.fresh]), [[8, true], [29, false]]);
  assert.equal(oldHits[0].speedBefore, 0);
  assert.ok(oldHits[0].speedAfter > 6 && oldHits[0].healthLoss > 20);
  assert.equal(oldHits[0].damage.impactCount, 0);
  assert.equal(oldHits[0].hatchInwardM, 0);
  assert.ok(oldHits[1].damage.rear > 0 && oldHits[1].hatchInwardM > 0);
  t.diagnostic(JSON.stringify({ archivedDigest: archived.drivable, archivedContacts: oldHits }));

  const current = trace(profile);
  assert.equal(current.drivable, archived.drivable, "the feedback cannot change motion, observation, incidents, health or reward");
  const [first, held] = current.frames.filter(frame => frame.contact);
  assert.equal(first.damage.impactCount, 1);
  assert.equal(first.damage.lastImpact.side, "rear");
  assert.equal(first.damage.lastImpact.tick, first.tick);
  assert.equal(first.rendered.lastImpact.tick, first.tick);
  assert.ok(first.hatchInwardM > .01 && first.rendered.maximumDisplacementM > .1 && first.rendered.deformedVertices > 3,
    "a hard rear impact must move the visible hatch inward on the first contact tick");
  assert.deepEqual(current.frames.slice(0, first.tick - 1).map(f => f.damage.total), Array(first.tick - 1).fill(0));
  assert.deepEqual(held.damage, first.damage, "persistent contact must not dent the SUV again");
  assert.deepEqual(held.rendered, first.rendered);
  assert.equal(held.hatchInwardM, first.hatchInwardM);
  const clean = trace(profile, false);
  assert.ok(clean.frames.every(f => f.damage.impactCount === 0 && !f.rendered.deformedVertices && f.hatchInwardM === 0));
  assert.throws(() => new GtaPursuitEnv().reset({ config: profile }), /damageFeedback requires/);
  assert.throws(() => new GtaPursuitEnv().reset({
    config: { ruleset: "dispatch-v1", damageFeedback: "unknown" },
  }), /damageFeedback requires/);
  t.diagnostic(JSON.stringify({ currentDigest: current.drivable, currentContacts: [first, held],
    noTailFrames: clean.frames.length }));
});

test("real contact retains the skid's attached lower flange and frame supports, then resets exactly", (t) => {
  const { rig, actor } = fixture(t);
  const chassis = rig.root.getObjectByName("player-chassis");
  const bumper = rig.root.getObjectByName("suv-front-bumper");
  const skid = rig.root.getObjectByName("suv-front-skid");
  const pristine = geometryHash(rig.root);
  const bumperBefore = bumper.geometry.attributes.position.array.slice();
  const skidPose = skid.position.clone();
  const lenses = localLenses.map(([id]) =>
    rig.root.getObjectByName(`sensor-range-${id}`).getWorldPosition(new THREE.Vector3()));
  const world = new World({}, "vehicle");
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), true);
  for (let n = 0; n < 400 && world.vehicleTest.phase !== "contact"; n++) world.step();
  assert.equal(world.vehicleTest.phase, "contact");
  assert.equal(world.player.vehicle.damage.impactCount, 1);
  actor.vehicle = world.player.vehicle;
  rig.update(actor);
  for (const x of [-0.25, 0, 0.25])
    for (const y of [0.385, 0.397, 0.402]) {
      const cover = frontInterval(bumper, chassis, x, y);
      const guard = frontInterval(skid, chassis, x, y);
      assert.ok(cover.front - guard.back >= 0.03,
        "the bolted lower flange must overlap the rigid skid, not merely touch after a dent");
    }
  const positions = bumper.geometry.attributes.position;
  let pinned = 0, dented = 0;
  for (let i = 0; i < positions.count; i++) {
    const [x, y, z] = bumperBefore.slice(i * 3, i * 3 + 3);
    if (Math.abs(x) < 0.4 && y < 0.435) {
      assert.deepEqual(Array.from(positions.array.slice(i * 3, i * 3 + 3)), [x, y, z]);
      pinned++;
    }
    if (y > 0.6 && positions.getZ(i) < z - 0.025) dented++;
  }
  assert.ok(pinned > 3 && dented > 3, "attachment restraint must not erase the actual local dent");
  assert.deepEqual(skid.position, skidPose, "the rigid underguard is not a sliding damage prop");
  const subframe = rig.root.getObjectByName("suv-subframe-1.3");
  const contains = (part, position) => new THREE.Box3()
    .setFromBufferAttribute(part.geometry.attributes.position)
    .containsPoint(part.worldToLocal(position.clone()));
  const connected = (support) =>
    contains(subframe, support.localToWorld(new THREE.Vector3(0, -0.5, 0))) &&
    contains(skid, support.localToWorld(new THREE.Vector3(0, 0.5, 0)));
  for (const side of [-1, 1]) {
    const support = rig.root.getObjectByName(`suv-front-skid-support-${side}`);
    assert.ok(support && connected(support), "both skid stays must meet real frame and guard geometry");
    const pose = support.position.clone();
    support.position.y -= 0.2;
    support.updateWorldMatrix(true, false);
    assert.equal(connected(support), false, "an actually floating stay must fail this oracle");
    support.position.copy(pose);
    support.updateWorldMatrix(true, false);
  }
  localLenses.forEach(([id], i) => close(rig.root.getObjectByName(`sensor-range-${id}`)
    .getWorldPosition(new THREE.Vector3()).distanceTo(lenses[i]), 0));
  actor.vehicle = new World(world.config, "vehicle").player.vehicle;
  rig.update(actor);
  assert.equal(geometryHash(rig.root), pristine);
  assert.deepEqual(skid.position, skidPose);
});

test("cutaway reveals cabin/running gear without floating roof hardware and restores every authored surface", (t) => {
  const { rig } = fixture(t);
  const before = geometryHash(rig.root);
  rig.setInspection({ cutaway: true });
  for (const name of ["suv-faceted-roof", "suv-windshield", "suv-windshield-wipers", "suv-left-doors", "sensor-roof-imu-gnss"])
    assert.equal(rig.root.getObjectByName(name).visible, false, name);
  for (const name of ["suv-cabin-floor", "suv-center-console", "suv-left-door-cladding", "wheel-front-left-spring"])
    assert.equal(rig.root.getObjectByName(name).visible, true, name);
  rig.setInspection({ cutaway: false });
  for (const name of ["suv-faceted-roof", "suv-windshield", "suv-windshield-wipers", "suv-left-doors", "sensor-roof-imu-gnss"])
    assert.equal(rig.root.getObjectByName(name).visible, true, name);
  assert.equal(geometryHash(rig.root), before);
});

test("disposal is idempotent and disposes each actual owned GPU resource only once", () => {
  const rig = createPlayerVehicle(null, makeActor());
  const resources = new Set();
  rig.root.traverse((part) => {
    if (part.geometry) resources.add(part.geometry);
    if (part.material) resources.add(part.material);
  });
  const counts = new Map([...resources].map((resource) => [resource, 0]));
  for (const resource of resources)
    resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource) + 1));
  rig.dispose(); rig.dispose();
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.equal(rig.root.children.length, 0);
  assert.equal(rig.diagnostics.disposed, true);
});

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase(); this.document = document;
    this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.textContent = ""; this.hidden = false; this.disabled = false;
  }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  fire(type, details = {}) {
    if (type === "click" && this.disabled) return;
    const event = { type, target: this, preventDefault() {}, ...details };
    for (let parent = this; parent; parent = parent.parentNode)
      for (const callback of parent.listeners.get(type) ?? []) callback(event);
  }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}
function panelFixture(t, action) {
  const savedDocument = globalThis.document;
  const document = new Element("document"); document.document = document;
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body"); document.append(document.body);
  globalThis.document = document;
  const toolbar = document.createElement("nav"), incumbent = document.createElement("button");
  incumbent.id = "incumbent"; toolbar.append(incumbent); document.body.append(toolbar);
  const calls = [];
  const panel = mountVehiclePanel({
    toolbar, onAction: (name, value) => {
      calls.push([name, value]); return action ? action(name, value) : { ok: true };
    },
  });
  const find = (predicate, parent = document) =>
    predicate(parent) ? parent : parent.children.map((child) => find(predicate, child)).find(Boolean);
  const byId = (id) => find((element) => element.id === id);
  t.after(() => {
    panel.dispose();
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  });
  return {
    panel, calls, document, toolbar, incumbent, byId, find,
    state: {
      world: { environment: "city", sensors: { rawM: [12, 14, 9.5, 18, 35] } },
      actor: makeActor(), rig: { root: {}, diagnostics: { ready: true } },
      mode: "chase", cutaway: false, sensors: false, sensorCamera: "front",
    },
  };
}

test("scoped controls emit real front/rear camera selection and reject unavailable actions visibly", (t) => {
  const f = panelFixture(t, (action) =>
    action === "sensors" ? { ok: false, error: "Virtual geometry is unavailable." } : { ok: true });
  f.panel.update(f.state); f.byId("carToggleBtn").fire("click");
  assert.equal(f.byId("carPanel").hidden, false);
  f.find((element) => element.dataset.carView === "cockpit").fire("click");
  assert.deepEqual(f.calls.at(-1), ["view", "cockpit"]);
  const camera = f.byId("carSensorCamera");
  camera.value = "rear"; camera.fire("change");
  assert.deepEqual(f.calls.at(-1), ["sensor-camera", "rear"]);
  f.state.sensorCamera = "rear"; f.panel.update(f.state);
  assert.equal(camera.value, "rear");
  const cutaway = f.byId("carCutaway"); cutaway.checked = true; cutaway.fire("change");
  assert.deepEqual(f.calls.at(-1), ["cutaway", true]);
  const sensors = f.byId("carSensors"); sensors.checked = true; sensors.fire("change");
  assert.equal(sensors.checked, false);
  assert.equal(f.byId("carActionError").hidden, false);
  assert.match(f.byId("carActionError").textContent, /unavailable/);
  f.document.fire("keydown", { key: "Escape" });
  assert.equal(f.byId("carPanel").hidden, true);
  assert.equal(f.document.activeElement, f.byId("carToggleBtn"));
});

test("rear/side readings and virtual telemetry display actual supplied values and explicit unavailable state", (t) => {
  const f = panelFixture(t);
  f.state.world.sensors.auxiliary = [
    { id: "rear-left", rangeM: 3.25 }, { id: "rear-center", rangeM: 2.1 },
    { id: "rear-right", rangeM: 4 }, { id: "side-left", rangeM: 0.85 },
    { id: "side-right", rangeM: 12.7 },
  ];
  f.state.world.sensors.imu = {
    source: "simulated-vehicle-state", positionM: { x: 18.35, y: 2, z: -11.1 },
    longitudinalAccelerationMps2: -4.1, yawRateRadS: Math.PI / 6,
  };
  f.panel.update(f.state);
  assert.equal(f.find((e) => e.dataset.carRange === "rear-center").textContent, "2.1");
  assert.equal(f.find((e) => e.dataset.carRange === "side-left").textContent, "0.8");
  const telemetry = f.byId("carTelemetry");
  assert.match(telemetry.children[0].textContent, /Virtual IMU \/ GNSS.*-4.1.*30.0/);
  assert.match(telemetry.children[1].textContent, /Y 2.0.*Z -11.1/);
  f.state.world.sensors.imu = null;
  f.state.world.sensors.auxiliary = [];
  f.panel.update(f.state);
  assert.match(telemetry.children[0].textContent, /unavailable/);
  assert.equal(f.find((e) => e.dataset.carRange === "rear-center").textContent, "—");
});

test("impact/reset boundaries, explicit city return, loading and panel disposal preserve incumbent actions", (t) => {
  const f = panelFixture(t); f.panel.update(f.state);
  const run = f.byId("carImpactRunBtn"), reset = f.byId("carResetBtn");
  assert.equal(run.disabled, true); assert.equal(reset.disabled, true);
  assert.match(run.title, /separate impact bay/);
  f.state.world.environment = "vehicle"; f.state.world.vehicleTest = { phase: "ready" };
  f.panel.update(f.state);
  assert.equal(run.disabled, false); assert.equal(reset.disabled, false);
  run.fire("click"); assert.deepEqual(f.calls.at(-1), ["impact-run", undefined]);
  f.state.world.vehicleTest.phase = "running"; f.panel.update(f.state);
  assert.equal(reset.disabled, true);
  f.state.world.vehicleTest.phase = "contact"; f.state.actor.speed = 1; f.panel.update(f.state);
  assert.equal(reset.disabled, true);
  f.state.actor.speed = 0; f.panel.update(f.state);
  reset.fire("click"); assert.deepEqual(f.calls.at(-1), ["reset-car", undefined]);
  f.byId("carReturnBtn").fire("click"); assert.deepEqual(f.calls.at(-1), ["return-city", undefined]);
  f.state.rig = null; f.panel.update(f.state);
  assert.equal(f.byId("carSensorCamera").disabled, true);
  f.state.rig = { root: {}, diagnostics: { ready: true } };
  f.state.world.vehicleTest = null; f.panel.update(f.state);
  assert.equal(reset.disabled, true); assert.match(f.byId("carTestStatus").textContent, /unavailable/);
  const toggle = f.byId("carToggleBtn"), callCount = f.calls.length;
  f.panel.dispose(); f.panel.dispose();
  assert.equal(f.byId("carPanel"), undefined);
  assert.equal(f.toolbar.children[0], f.incumbent);
  toggle.fire("click"); assert.equal(f.calls.length, callCount);
});
