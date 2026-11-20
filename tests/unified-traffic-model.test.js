import assert from "node:assert/strict";
import test from "node:test";
import { Box3, Color, Group, Raycaster, Vector3 } from "three";
import { VEHICLE } from "../src/core/config.js";
import { createEgyptDistrict } from "../src/core/egypt-district.js";
import {
  createUnifiedTrafficModel,
  disposeUnifiedTrafficModel,
} from "../src/render/unified-traffic-model.js";

const kinds = ["sedan", "taxi", "suv", "van", "tuktuk"];
const actor = (kind) => ({
  kind, phase: .1,
  width: kind === "tuktuk" ? 1.5 : VEHICLE.width,
  length: kind === "tuktuk" ? 2.9 : VEHICLE.length,
});
const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

function model(t, source) {
  const result = createUnifiedTrafficModel(source);
  t.after(() => disposeUnifiedTrafficModel(result.root));
  result.root.updateMatrixWorld(true);
  return result;
}

function meshes(root) {
  const parts = [];
  root.traverse((part) => { if (part.isMesh) parts.push(part); });
  return parts;
}

function ray(root, from, toward) {
  return new Raycaster(new Vector3(...from), new Vector3(...toward)).intersectObject(root, true)[0];
}

function color(hit) {
  assert.ok(hit, "sample ray must strike a surfaced triangle");
  return new Color().fromBufferAttribute(hit.object.geometry.attributes.color, hit.face.a);
}

test("moving and registered parked models fit the same centered metre-space envelope", (t) => {
  const parked = createEgyptDistrict().statics.filter((site) => site.kind === "parked-vehicle");
  for (const source of [...kinds.map(actor), ...parked]) {
    const shape = model(t, { ...source, x: 27, z: -13, heading: Math.PI / 2 });
    const { min, max } = new Box3().setFromObject(shape.root, true);
    near(min.x, -source.width / 2);
    near(max.x, source.width / 2);
    near(min.z, -source.length / 2);
    near(max.z, source.length / 2);
    near(min.y, 0);
    if (source.height) near(max.y, source.height);
    for (const { part, radius } of shape.wheels) {
      near(new Box3().setFromObject(part, true).min.y, 0);
      near(part.position.y, radius);
    }

    // The same mesh must still sit on the road after the caller applies
    // the actor's registered facing and placement on a parent.
    const placement = new Group();
    placement.position.set(13, .12, -9);
    placement.rotation.y = Math.PI / 2;
    placement.add(shape.root);
    const worldBox = new Box3().setFromObject(placement, true);
    near(worldBox.min.y, .12);
    near(worldBox.getSize(new Vector3()).x, source.length);
    near(worldBox.getSize(new Vector3()).z, source.width);
  }
});

test("rooflines, cowl proportions and the tuk-tuk side opening distinguish models without color", (t) => {
  const byKind = Object.fromEntries(kinds.map((kind) =>
    [kind, model(t, { ...actor("sedan"), kind, height: 1.90 }).root]));
  const top = (kind, x, z) => ray(byKind[kind], [x, 3, z], [0, -1, 0]).point.y;

  // The taxi has a discrete raised topper, not a reskinned sedan roof.
  assert.ok(top("taxi", 0, -.13) - top("taxi", .41, -.13) > .09);
  near(top("sedan", 0, -.13), top("sedan", .41, -.13));
  // A rear deck becomes a sloping cargo gate on the SUV; the van stays
  // tall at the back and carries its windshield much farther forward.
  assert.ok(top("suv", 0, -1.68) > top("sedan", 0, -1.68) + .42);
  assert.ok(top("van", 0, -1.68) > top("suv", 0, -1.68) + .15);
  assert.ok(top("van", 0, 1.47) > top("suv", 0, 1.47) + .19);
  assert.ok(top("tuktuk", 0, -1.68) > top("tuktuk", 0, 1.47) + .65);
  assert.equal(ray(byKind.tuktuk, [5, 1.05, -.42], [-1, 0, 0]), undefined);
  assert.ok(ray(byKind.tuktuk, [5, .47, -.42], [-1, 0, 0]), "floor and tub remain below that opening");
});

test("actual outward-facing triangles show lamps, grille, handles, glass and tire in the wheel opening", (t) => {
  const { root, wheels } = model(t, actor("sedan"));
  const checkFacing = () => {
    for (const side of [-1, 1]) {
      const front = color(ray(root, [side * .54, .675, 4], [0, 0, -1]));
      assert.ok(front.r > .7 && front.g > .6, "warm front lamp points toward +Z");
      const rear = color(ray(root, [side * .54, .742, -4], [0, 0, 1]));
      assert.ok(rear.r > .3 && rear.r > rear.g * 3 && rear.r > rear.b * 3, "red lens faces -Z");
    }
  };
  checkFacing();
  const grille = color(ray(root, [0, .58, 4], [0, 0, -1]));
  const glass = color(ray(root, [5, 1.13, 0], [-1, 0, 0]));
  const handle = color(ray(root, [5, .718, .173], [-1, 0, 0]));
  const door = color(ray(root, [5, .718, .29], [-1, 0, 0]));
  assert.ok(grille.getHex() < 0x444444);
  assert.ok(glass.r < door.r / 2 && glass.b > glass.r, "glazing contrasts with paint");
  assert.ok(handle.r < door.r / 2, "handle contrasts with surrounding door");
  assert.ok(wheels.some(({ part }) => part === ray(root, [5, .28, 1.302], [-1, 0, 0])?.object));
  assert.ok(wheels.every(({ part }) => part !== ray(root, [5, .28, .84], [-1, 0, 0])?.object));

  const tuk = model(t, actor("tuktuk")).root;
  assert.ok(color(ray(tuk, [0, .67, 4], [0, 0, -1])).r > .7, "the tuk-tuk has a centre headlamp");
  // Safe negative control: a reversed model fails the same real ray oracle.
  root.rotation.y = Math.PI;
  root.updateMatrixWorld(true);
  assert.throws(checkFacing, /front lamp/);
});

test("wheel meshes yaw about +Y and roll both ways about their own axle without widening the hull", (t) => {
  for (const kind of kinds) {
    const source = actor(kind);
    const { root, wheels } = model(t, source);
    const tuk = kind === "tuktuk";
    assert.equal(wheels.length, tuk ? 3 : 4);
    assert.equal(wheels.filter((wheel) => wheel.front).length, tuk ? 1 : 2);
    assert.equal(new Set(wheels.map(({ part }) => part)).size, wheels.length);
    if (tuk) near(wheels.find((wheel) => wheel.front).part.position.x, 0);

    for (const steer of [-VEHICLE.maxSteer, VEHICLE.maxSteer]) {
      for (const turn of [-1, 1]) {
        for (const { part, quaternion, front, radius } of wheels) {
          assert.ok(part.isMesh && radius > .17);
          assert.ok(front ? part.position.z > 0 : part.position.z < 0);
          // Public consumer convention: revert to the rest basis, steer,
          // then roll by signed distance/radius. Simulate a non-snap phase.
          const travel = turn * .61 * radius;
          part.quaternion.copy(quaternion);
          if (front) part.rotateY(steer);
          part.rotateX(travel / radius);
          const yaw = front ? steer : 0;
          const axle = new Vector3(1, 0, 0).applyQuaternion(part.quaternion);
          const mark = new Vector3(0, 1, 0).applyQuaternion(part.quaternion);
          near(axle.x, Math.cos(yaw));
          near(axle.z, -Math.sin(yaw));
          near(mark.dot(new Vector3(Math.sin(yaw), 0, Math.cos(yaw))), turn * Math.sin(.61));
          assert.notEqual(part.quaternion, quaternion);
        }
        const { min, max } = new Box3().setFromObject(root, true);
        near(min.y, 0, .008); // 16-sided tread, at most one facet's sagitta.
        near(max.x - min.x, source.width);
        near(max.z - min.z, source.length);
      }
    }
  }
});

test("seeded paint varies only surface color; families stay in a five-draw, two-material budget", (t) => {
  const metrics = [];
  for (const kind of kinds) {
    const original = model(t, actor(kind)).root;
    const same = model(t, actor(kind)).root;
    const other = model(t, { ...actor(kind), phase: .86 }).root;
    const parts = meshes(original), repeat = meshes(same), variant = meshes(other);
    assert.ok(parts.length <= 5 && parts.length === repeat.length);
    const materials = new Set(parts.map((part) => part.material));
    assert.ok(materials.size <= 2);
    let triangles = 0;
    for (let i = 0; i < parts.length; i++) {
      const { geometry, material } = parts[i];
      assert.equal(geometry.groups.length, 0);
      assert.ok(!material.map && !material.transparent && material.vertexColors);
      assert.ok(material.flatShading && material.roughness >= .90 && material.metalness === 0);
      assert.deepEqual(geometry.attributes.position.array, variant[i].geometry.attributes.position.array);
      assert.deepEqual(geometry.attributes.color.array, repeat[i].geometry.attributes.color.array);
      triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
    }
    assert.ok(parts.some(({ geometry }, i) => geometry.attributes.color.array.some(
      (channel, j) => channel !== variant[i].geometry.attributes.color.array[j])));
    assert.ok(triangles <= 1500, `${kind} renders ${triangles} triangles`);
    metrics.push(`${kind}=${triangles}`);
  }
  t.diagnostic(`rendered triangles per model: ${metrics.join(", ")}`);
});

test("ownership works for WorldView traversal and one-off despawns without releasing neighbors", () => {
  const parent = new Group(), patrolOverlay = new Group();
  const despawned = createUnifiedTrafficModel(actor("sedan"));
  const remaining = createUnifiedTrafficModel(actor("sedan"));
  parent.add(despawned.root, remaining.root, patrolOverlay);
  const counts = ({ root }) => {
    const events = new Map();
    for (const { geometry, material } of meshes(root)) {
      for (const resource of [geometry, material]) {
        if (events.has(resource)) continue;
        assert.equal(resource.userData.owned, true);
        events.set(resource, 0);
        resource.addEventListener("dispose", () => events.set(resource, events.get(resource) + 1));
      }
    }
    return events;
  };
  const removed = counts(despawned), retained = counts(remaining);
  assert.equal(removed.size, 4, "body pair and one tire pair shared within, not across, models");
  assert.ok([...removed.keys()].every((resource) => !retained.has(resource)));
  disposeUnifiedTrafficModel(despawned.root);
  disposeUnifiedTrafficModel(despawned.root);
  assert.equal(despawned.root.parent, null);
  assert.equal(patrolOverlay.parent, parent);
  assert.equal(remaining.root.parent, parent);
  assert.ok([...removed.values()].every((events) => events === 1));
  assert.ok([...retained.values()].every((events) => events === 0));

  parent.traverse((part) => {
    if (!part.userData.owned) return;
    part.geometry.dispose();
    part.material.dispose();
  });
  assert.ok([...retained.values()].every((events) => events === 1));
});
