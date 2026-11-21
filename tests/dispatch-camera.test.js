import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";

const van = { x: 0, z: -4.8, y: .12, heading: 0, width: 2.1, length: 5.2, height: 2.1 };
const input = { position: new Vector3(0, .12, 0), heading: 0, speedMps: 11,
  streetWidthM: 14, deltaS: 1 / 60 };

function blocked(camera, body) {
  const cabin = new Vector3(0, 1.38, 0);
  for (let i = 0; i <= 350; i++) {
    const point = cabin.clone().lerp(camera.position, i / 350);
    if (Math.abs(point.x - body.x) < body.width / 2 && Math.abs(point.z - body.z) < body.length / 2 &&
        point.y > body.y && point.y < body.y + body.height) return true;
  }
  return false;
}

test("Metro Dispatch clears a tall tail vehicle instead of hiding the SUV", () => {
  const fixed = new PerspectiveCamera(62, 1365 / 900, .1, 500);
  const comparison = fixed.clone();
  createPursuitCamera().update(comparison, { ...input, snap: true });
  assert.ok(blocked(comparison, van), "the ordinary low boom must actually be obstructed in this fixture");
  createPursuitCamera().update(fixed, { ...input, snap: true, trailingVehicles: [van] });
  assert.ok(!blocked(fixed, van));
  assert.ok(fixed.position.z < -5 && fixed.position.y > 6, "retain a view of nearby traffic");
  fixed.updateMatrixWorld();
  const cabin = new Vector3(0, 1.38, 0).project(fixed);
  assert.ok(Math.abs(cabin.x) < .7 && Math.abs(cabin.y) < .7, "the SUV remains framed");
});

test("the Dispatch boom moves smoothly past occlusion and preserves the building guard", () => {
  const camera = new PerspectiveCamera(62, 390 / 844, .1, 500);
  const follow = createPursuitCamera();
  const behind = { x: 0, z: -11, y: .12, heading: 0, width: 6, length: 1, height: 16 };
  const staticIndex = new SpatialIndex([behind]);
  const insideWall = eye => Math.abs(eye.x) < 3 && Math.abs(eye.z + 11) < .5 && eye.y < 16.12;
  follow.update(camera, { ...input, snap: true, staticIndex });
  const ordinary = camera.position.clone();
  for (let i = 0; i < 80; i++) {
    const prior = camera.position.clone();
    follow.update(camera, { ...input, staticIndex, trailingVehicles: [van] });
    assert.ok(camera.position.distanceTo(prior) < 1.5, "avoid a one-frame camera jump");
    for (let point = 1; point <= 20; point++) assert.ok(!insideWall(prior.clone().lerp(camera.position, point / 20)));
  }
  assert.ok(!blocked(camera, van));
  for (let i = 0; i < 80; i++) follow.update(camera, { ...input, staticIndex, trailingVehicles: [] });
  assert.ok(camera.position.distanceTo(ordinary) < .2, "return to the ordinary view after the van leaves");
});
