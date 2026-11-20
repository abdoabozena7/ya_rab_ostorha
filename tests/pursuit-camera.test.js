import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import { VEHICLE } from "../src/core/config.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";

const makeCamera = (aspect = 1365 / 900) => new PerspectiveCamera(62, aspect, 0.1, 500);
const makeInput = (settings) => ({
  position: new Vector3(0, 0.12, 0), heading: 0, speedMps: 0, streetWidthM: 3.8,
  deltaS: 1 / 60, ...settings,
});
const PATROL = { width: VEHICLE.width, length: VEHICLE.length, height: 1.64 };
const SUV = { width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM, height: PLAYER_VEHICLE.heightM };

function assertBodyFraming(camera, position, width, height, patrolGaps) {
  camera.updateMatrixWorld();
  const project = (x, y, z) => {
    const point = new Vector3(x, y, z).add(position).project(camera);
    assert.ok(point.z > -1 && point.z < 1, "point is inside the camera depth range");
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  const silhouette = (body, gap, lane = 0) => {
    const points = [];
    for (const x of [-body.width / 2, body.width / 2])
      for (const y of [0, body.height])
        for (const z of [-body.length / 2, body.length / 2])
          points.push(project(x + lane, y, z - gap));
    return {
      left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
      top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)),
    };
  };
  const visible = (box, label) => {
    assert.ok(box.left >= 16 && box.right <= width - 16 && box.top >= 16 && box.bottom <= height - 45,
      `${label} bounds ${JSON.stringify(box)} must clear viewport edges and the footer buttons`);
  };
  for (const gap of patrolGaps) visible(silhouette(PATROL, gap), `full rear patrol at ${gap} m`);
  visible(silhouette(PATROL, 8.5, 5.4), "patrol in the adjacent lane");
  const suv = silhouette(SUV, 0);
  visible(suv, "SUV");
  assert.ok(suv.right - suv.left > 0.08 * height && suv.bottom - suv.top > 0.09 * height,
    "SUV reads at viewport scale");
  for (const laneEdge of [-5.4, 5.4]) {
    const ahead = project(laneEdge, 0, 30);
    assert.ok(ahead.x > 0 && ahead.x < width && ahead.y > 60 && ahead.y < suv.top, "road edges ahead");
  }
}

test("the pursuit display shortens for a rotated wall but not a low closure beneath it", () => {
  const camera = makeCamera(), follow = createPursuitCamera();
  const wall = { x: 0, z: -6, width: 7, length: 1.6, heading: Math.PI / 6, height: 12 };
  const position = new Vector3(0, 0.12, 0);
  follow.update(camera, makeInput({ position, staticIndex: new SpatialIndex([wall]), snap: true }));
  // At x=0, the near face of this skewed slab is at z≈−5.08.
  assert.ok(camera.position.z > -5.08 && camera.position.z < -3.5);
  assert.ok(camera.position.y > 2.0, "the camera stays above the roof even when retracted");
  assert.deepEqual(position.toArray(), [0, 0.12, 0]);

  const low = { ...wall, height: 0.7 };
  follow.update(camera, makeInput({ position, staticIndex: new SpatialIndex([low]), snap: true }));
  assert.ok(camera.position.z < -9, "a low barricade does not make the shot unnecessarily tight");
});

test("a damped turn retracts around a solid corner and recovers on the other street", () => {
  const block = { x: 3, z: 3, width: 6, length: 6, height: 16, kind: "building" };
  const staticIndex = new SpatialIndex([block]), follow = createPursuitCamera(), camera = makeCamera();
  const empty = makeCamera(), unguarded = createPursuitCamera();
  const position = new Vector3(1.7, 0.12, -1.2);
  let heading = -Math.PI / 2;
  const update = (snap = false) => {
    const input = makeInput({ position, heading, speedMps: 7, streetWidthM: 6, snap });
    follow.update(camera, { ...input, staticIndex });
    unguarded.update(empty, input);
  };
  update(true);
  assert.ok(camera.position.x > 10 && camera.position.z < -1);
  const sample = new Vector3();
  const inside = (p) => p.x > 0 && p.x < 6 && p.z > 0 && p.z < 6 && p.y < 16;
  let sawUnguardedCut = false;
  for (let tick = 0; tick < 100; tick++) {
    // The ego rounds the open side of the corner, then holds on a clear street.
    position.x = 1.7 - 2.9 * Math.min(tick / 15, 1);
    position.z = -1.2 + 2.9 * Math.max(0, Math.min((tick - 15) / 15, 1));
    heading = -Math.PI / 2 - Math.PI / 2 * Math.min(tick / 22, 1);
    const previous = camera.position.clone();
    update();
    sawUnguardedCut ||= inside(empty.position);
    assert.ok(camera.position.distanceTo(previous) < 1.6, `no corner teleport at tick ${tick}`);
    for (let i = 1; i <= 30; i++) {
      sample.lerpVectors(previous, camera.position, i / 30);
      assert.ok(!inside(sample), `camera sweep never enters the block at tick ${tick}`);
    }
  }
  assert.ok(sawUnguardedCut, "the fixture catches ordinary damped follow cutting through the block");
  assert.ok(camera.position.x < -1 && camera.position.z > 10, "gives the player their follow distance back");
});

test("the moving avenue shot keeps whole rear patrols framed through 14 m without pulling an alley wide", () => {
  for (const [width, height] of [[1365, 900], [900, 650]]) {
    const camera = makeCamera(width / height), follow = createPursuitCamera();
    const position = new Vector3(0, 0.12, 0);
    const input = makeInput({ position, speedMps: 13.7, streetWidthM: 14 });
    for (let tick = 0; tick < 120; tick++) {
      position.z += input.speedMps * input.deltaS;
      follow.update(camera, input);
    }
    assertBodyFraming(camera, position, width, height, [13, 14]);
    const long = camera.position.distanceTo(position);
    follow.update(camera, { ...input, streetWidthM: 3.8, snap: true });
    assert.ok(camera.position.distanceTo(position) < long * 0.72);
    assert.ok(Math.abs(camera.position.x) < 0.05, "leave both walls room in a narrow lane");
  }
});

test("braking on a boulevard keeps the whole trailing sedan clear of the buttons at 900 by 650", () => {
  const camera = makeCamera(900 / 650), follow = createPursuitCamera();
  const position = new Vector3(0, 0.12, 0), slowMps = 19 / 3.6;
  const input = makeInput({ position, streetWidthM: 14 });
  const drive = (speedMps) => {
    position.z += speedMps * input.deltaS;
    follow.update(camera, { ...input, speedMps });
  };
  for (let tick = 0; tick < 120; tick++) drive(13.7);
  for (let tick = 1; tick <= 90; tick++) drive(13.7 + (slowMps - 13.7) * tick / 90);
  // Hold the lower pace so follow lag cannot hide an overly tight final shot.
  for (let tick = 0; tick < 90; tick++) drive(slowMps);
  assertBodyFraming(camera, position, 900, 650, [8, 9, 10]);
});
