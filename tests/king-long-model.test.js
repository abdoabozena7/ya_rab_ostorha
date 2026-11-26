import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { KING_LONG_MICROBUS_ID, getVehicleMounts } from "../src/core/vehicle-spec.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import { measureVehicleSensors } from "../src/signal_processing/range-sensors.js";

const vec = ({ x, y, z }) => new THREE.Vector3(x, y, z);
const pivots = [
  ["frontLeft", "wheel-front-left", -0.725, 1.555],
  ["frontRight", "wheel-front-right", 0.725, 1.555],
  ["rearLeft", "wheel-rear-left", -0.725, -1.015],
  ["rearRight", "wheel-rear-right", 0.725, -1.015],
];

function close(observed, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(observed - expected) < tolerance, `${observed} does not match ${expected}`);
}

function fixture(t) {
  const actor = {
    id: "player", type: "player", x: 0, y: 0, z: 0, heading: 0, speed: 0, distance: 0,
    vehicleModel: KING_LONG_MICROBUS_ID, length: 4.84, width: 1.70, height: 2.02,
  };
  actor.vehicle = createVehicleState(actor);
  const rig = createPlayerVehicle(null, actor);
  t.after(() => rig.dispose());
  return { actor, rig, part: (name) => rig.root.getObjectByName(name) };
}

function sight(root, origin, aim, far = 20) {
  root.updateMatrixWorld(true);
  const surfaces = [];
  root.traverseVisible((part) => {
    if (part.isMesh && !part.name.includes("-pool")) surfaces.push(part);
  });
  const start = new THREE.Vector3(...origin);
  const direction = new THREE.Vector3(...aim).sub(start).normalize();
  return new THREE.Raycaster(start, direction, 0.025, far).intersectObjects(surfaces);
}

test("the player renderer selects a distinct white short-nose shell with the reference silhouette", (t) => {
  const { rig, part } = fixture(t);
  const suv = createPlayerVehicle(null, { length: 4.2, width: 1.85 });
  t.after(() => suv.dispose());
  assert.equal(suv.diagnostics.asset, "Original faceted SUV");
  assert.ok(suv.root.getObjectByName("suv-hood"));
  assert.equal(suv.root.getObjectByName("king-long-shell"), undefined);
  assert.equal(rig.diagnostics.asset, "King Long microbus");
  assert.equal(rig.diagnostics.vehicleModel, KING_LONG_MICROBUS_ID);
  assert.equal(part("suv-hood"), undefined);

  const shell = part("king-long-shell");
  const enamel = part("king-long-rounded-white-roof").material;
  assert.ok(enamel.color.r > 0.85 && enamel.color.b > 0.85, "light solid paint rather than SUV body gray");
  const whiteBody = new THREE.Box3();
  shell.traverse((node) => {
    if (node.isMesh && node.material === enamel) whiteBody.expandByObject(node, true);
  });
  const size = whiteBody.getSize(new THREE.Vector3());
  close(size.x, 1.70); close(size.z, 4.84); close(whiteBody.max.y, 2.02);

  for (const z of [-1.60, -0.40, 0.50, 1.18]) {
    const roof = sight(rig.root, [0.26, 4, z], [0.26, 0, z])[0];
    assert.equal(roof.object.name, "king-long-rounded-white-roof");
    close(roof.point.y, 2.02, 0.002);
  }
  const frontAt = (x, y) => sight(rig.root, [x, y, 4], [x, y, 0])[0];
  const glassLow = frontAt(-0.2, 1.41), glassHigh = frontAt(-0.2, 1.82);
  assert.equal(glassLow.object.name, "king-long-windshield");
  assert.equal(glassHigh.object.name, "king-long-windshield");
  assert.ok(glassLow.point.z - glassHigh.point.z > 0.29, "windshield is strongly raked");
  for (const [x, y, name] of [
    [0, 0.920, "satin-grille-slats"],
    [0.45, 0.92, "right-headlight-main"],
    [0.737, 0.917, "right-headlight-indicator"],
    [0, 0.666, "front-bumper-strip"],
    [0.16, 0.461, "lower-pill-intake"],
    [0.61, 0.47, "right-fog-lamp"],
  ]) assert.equal(frontAt(x, y).object.name, `king-long-${name}`);

  const sideAt = (z, y) => sight(rig.root, [2, y, z], [0, y, z])[0].object.name;
  assert.equal(sideAt(-1.55, 1.64), "king-long-right-rear-passenger-glass");
  assert.equal(sideAt(-0.15, 1.64), "king-long-right-middle-passenger-glass");
  assert.equal(sideAt(-0.824, 1.64), "king-long-right-pillars", "slim solid pillar between the two passenger bays");
  assert.equal(sideAt(1.40, 1.32), "king-long-right-front-door-glass", "front pane drops below the passenger belt");
  assert.equal(sideAt(0.52, 1.18), "king-long-right-door-handles");
  const rear = (x, y) => sight(rig.root, [x, y, -4], [x, y, 0])[0].object.name;
  assert.equal(rear(0, 1.62), "king-long-hatch-glass");
  assert.equal(rear(0.76, 1.28), "king-long-right-vertical-tail-light");
});

test("real tire geometry fits actual road pivots and signed sampled travel spins the rim, not the caliper", (t) => {
  const { actor, rig, part } = fixture(t);
  for (const [key, name, x, z] of pivots) {
    const wheel = part(name);
    assert.equal(wheel.parent, rig.root, "the City applies each curb offset to the actual steer pivot");
    close(wheel.position.x, x); close(wheel.position.z, z);
    close(rig.diagnostics.wheels[key].radiusM, 0.315);
    const tire = part(`${name}-tire`);
    const bounds = new THREE.Box3().setFromObject(tire, true);
    close(bounds.min.y, 0); close(bounds.max.y, 0.63);
    close(bounds.getSize(new THREE.Vector3()).x, 0.195);
    assert.ok(Math.abs(bounds.max.x) < 0.85 && Math.abs(bounds.min.x) < 0.85);
    const side = Math.sign(x), eye = [1.32 * side, 0.43, z], aim = [0, 0.43, z];
    const tireHit = sight(rig.root, eye, aim, 0.55)[0];
    assert.match(tireHit?.object.name ?? "", /-(rim|tire)$/);
    wheel.visible = false;
    assert.equal(sight(rig.root, eye, aim, 0.55).length, 0, "body has an actual cut-out behind the wheel");
    wheel.visible = true;
    assert.equal(sight(rig.root, [1.32 * side, 0.76, z], [0, 0.76, z])[0].object.name,
      `king-long-${side < 0 ? "left" : "right"}-sill-and-arches`, "skin resumes just above the arch");
  }
  const moving = { ...actor, z: -0.105, steer: 0.29, speed: -6.3, previous: actor };
  moving.vehicle = advanceVehicleState(actor, moving, { steer: 0.29, targetSpeed: -6.3 }, 1 / 60);
  assert.equal(rig.sync(moving, undefined, 0.5), rig.root);
  for (const [key, name] of pivots) {
    close(part(name).rotation.y, (moving.vehicle.wheelAngles[key] ?? 0) * 0.5);
    close(part(`${name}-spin`).rotation.x, -0.105 / 0.315 / 2);
    close(part(`${name}-caliper`).rotation.x, 0);
  }
  assert.notEqual(part("wheel-front-left").rotation.y, part("wheel-front-right").rotation.y);
  close(part("cockpit-steering").rotation.z, moving.vehicle.steeringWheelRad);
  assert.deepEqual(part("cockpit-dashboard").userData.reading, { speedKmh: -6.3 * 3.6, gear: "R", brake: 0 });
});

test("the high left-hand cockpit can see both the road and instruments; cutaway exposes benches and running gear", (t) => {
  const { rig, part } = fixture(t);
  const { position, target } = rig.getCameraPose("cockpit");
  const eye = vec(position).toArray();
  assert.ok(position.x < -0.3 && position.y > 1.55 && position.z > 0.8);
  for (const towards of [vec(target).toArray(), [position.x, 0, 6], [-1.3, 1.4, 6], [1.3, 1.4, 6]])
    assert.equal(sight(rig.root, eye, towards).length, 0, "no opaque van body in the driver road sightline");
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 150);
  camera.position.copy(vec(position));
  camera.lookAt(vec(target));
  camera.updateMatrixWorld();
  for (const [aim, name] of [
    [[-0.38, 1.296, 1.646], "king-long-instrument-display"],
    [[-0.387, 1.315, 1.425], "king-long-three-spoke-steering-wheel"],
  ]) {
    const hit = sight(rig.root, eye, aim)[0];
    assert.equal(hit.object.name, name);
    const ndc = hit.point.project(camera);
    assert.ok(Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1, `${name} must be inside the actual cockpit frustum`);
  }

  const centerHit = (mode) => {
    const pose = rig.getCameraPose(mode);
    return sight(rig.root, vec(pose.position).toArray(), vec(pose.target).toArray())[0]?.object.name;
  };
  assert.match(centerHit("inspection"), /-front-door-glass$/);
  rig.setInspection({ cutaway: true });
  assert.match(centerHit("inspection"), /king-long-bench-/);
  assert.equal(centerHit("running-gear"), "king-long-propshaft");
  assert.equal(part("king-long-shell").visible, false);
  assert.equal(part("king-long-passenger-bench-3").visible, true);
  rig.setInspection({ cutaway: false });
  assert.equal(part("king-long-shell").visible, true);
  const frame = part("king-long-underframe");
  assert.throws(() => rig.withExteriorChaseCulling(() => {
    assert.equal(frame.visible, false);
    assert.equal(part("king-long-cabin").visible, true, "tinted glazing is not opaque; retain visible interior");
    throw new Error("render failed");
  }), /render failed/);
  assert.equal(frame.visible, true);
});

test("rendered lenses, view poses and ray endpoints agree with the shared vehicle mounts", (t) => {
  const { actor, rig, part } = fixture(t);
  actor.x = 2; actor.z = -5; actor.heading = 0.52;
  const c = Math.cos(actor.heading), s = Math.sin(actor.heading);
  rig.root.position.set(actor.x, 0.12, actor.z);
  rig.root.rotation.y = actor.heading;
  const obstacle = { id: "ahead", type: "pedestrian", height: 2, radius: 0.3,
    x: actor.x + s * 8.46, z: actor.z + c * 8.46 };
  const sensors = measureVehicleSensors({ actors: [actor, obstacle] }, actor);
  rig.update(actor, sensors);
  rig.setInspection({ sensors: true });
  const center = rig.diagnostics.sensors.ranges.find((row) => row.id === "center");
  close(center.worldPosition.x, actor.x + s * 2.46);
  close(center.worldPosition.z, actor.z + c * 2.46);
  close(center.rangeM, 5.7);
  assert.equal(center.hitId, "ahead");
  assert.equal(rig.diagnostics.sensors.ranges.length, 5);
  assert.equal(rig.diagnostics.sensors.auxiliary.length, 5);
  for (const ray of sensors.rays) {
    const lens = part(`sensor-range-${ray.id}`);
    const beam = part(`sensor-ray-${ray.id}`);
    const a = beam.geometry.attributes.position;
    close(lens.getWorldPosition(new THREE.Vector3()).distanceTo(vec(ray.origin)), 0);
    close(beam.localToWorld(new THREE.Vector3().fromBufferAttribute(a, 0)).distanceTo(vec(ray.origin)), 0);
    close(beam.localToWorld(new THREE.Vector3().fromBufferAttribute(a, 1)).distanceTo(vec(ray.end)), 0, 3e-6);
  }
  const { cameras, telemetry } = getVehicleMounts(actor);
  for (const [i, mode] of ["sensor", "sensor-rear"].entries()) {
    const pose = rig.getCameraPose(mode);
    assert.deepEqual(pose.position, cameras[i].position);
    const origin = rig.root.localToWorld(vec(pose.position)).toArray();
    const aim = rig.root.localToWorld(vec(pose.target)).toArray();
    close(part(`sensor-${cameras[i].id}`).getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...origin)), 0);
    assert.equal(sight(rig.root, origin, aim).length, 0, "camera must not view its own van body");
  }
  close(vec(rig.diagnostics.sensors.telemetry.worldPosition).distanceTo(rig.root.localToWorld(vec(telemetry.position))), 0);
  rig.withSensorOverlayCulling(() => assert.equal(part("vehicle-sensor-rays").visible, false));
  assert.equal(part("vehicle-sensor-rays").visible, true);
});

test("impact and brakes affect the procedural parts and a swapped-out rig disposes each shared resource once", (t) => {
  const { actor, rig, part } = fixture(t);
  const nose = part("king-long-front-fascia").geometry.attributes.position;
  const pristine = nose.array.slice();
  const roof = part("king-long-rounded-white-roof").geometry.attributes.position;
  const intactRoof = roof.array.slice();
  const tail = part("king-long-right-vertical-tail-light").material;
  const idleTail = tail.emissiveIntensity;
  const crashed = { ...actor, speed: 0 };
  crashed.vehicle = advanceVehicleState(actor, crashed, { targetSpeed: 0, steer: 0 }, 1 / 60, {
    freshImpacts: [{ side: "front", closingSpeedMps: 8, energyJ: 33000, lateralOffsetM: 0.15 }],
  });
  crashed.vehicle.controls.brake = 1;
  rig.update(crashed);
  assert.equal(rig.diagnostics.damage.impactCount, 1);
  assert.ok(rig.diagnostics.damage.deformedVertices > 20);
  assert.ok(rig.diagnostics.damage.maximumDisplacementM > 0.03);
  assert.notDeepEqual(nose.array, pristine);
  assert.deepEqual(roof.array, intactRoof, "front impact is localized");
  assert.ok(tail.emissiveIntensity > idleTail);
  rig.update(actor);
  assert.equal(rig.diagnostics.damage.impactCount, 0);
  assert.deepEqual(nose.array, pristine);
  close(tail.emissiveIntensity, idleTail);

  const scene = new THREE.Scene();
  scene.add(rig.root);
  const resources = new Set();
  rig.root.traverse((object) => {
    if (!object.geometry) return;
    resources.add(object.geometry);
    resources.add(object.material);
    if (object.material.map) resources.add(object.material.map);
  });
  const released = new Map();
  for (const resource of resources)
    resource.addEventListener("dispose", () => released.set(resource, (released.get(resource) ?? 0) + 1));
  rig.dispose();
  rig.dispose();
  assert.equal(released.size, resources.size);
  assert.ok([...released.values()].every((count) => count === 1));
  assert.equal(scene.children.length, 0);
  assert.equal(rig.root.children.length, 0);
  assert.equal(rig.diagnostics.disposed, true);
});
