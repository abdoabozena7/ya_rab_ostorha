import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeDiagonalRoad, roadPointAt } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { createEgyptStreetLayer, usesCityV4StreetFinish } from "../src/render/egypt-streets.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";
import { WorldView } from "../src/render/world-view.js";
import { mountRolloutPlayback } from "../src/ui/pako-rollouts.js";

function makeSyntheticV5World() {
  const diagMain = makeDiagonalRoad({
    id: "nile-diagonal-avenue",
    x1: -480,
    z1: -360,
    x2: 360,
    z2: 300,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10.5,
    zone: "avenue",
    marking: "center",
  });
  const orthoCross = {
    id: "central-cross-avenue",
    axis: "z",
    fixed: -60,
    min: -380,
    max: 320,
    width: 13,
    laneOffsetM: 2.6,
    speedLimitMps: 9.8,
    flow: 0,
    zone: "avenue",
    marking: "center",
  };
  const slashLocal = makeDiagonalRoad({
    id: "bazaar-slash-local",
    x1: -220,
    z1: 180,
    x2: 120,
    z2: -140,
    width: 9.6,
    laneOffsetM: 2.1,
    speedLimitMps: 6.8,
    zone: "neighborhood",
    marking: "none",
    sideStreet: true,
  });

  // Place a monumental 50 m tall diagonal-aligned building facing diagMain at along = 220 m
  const setback = diagMain.width / 2 + 4.0 + 16;
  const bPos = roadPointAt(diagMain, 220, setback);
  // Face 1 (+X local -> heading + PI/2) or Face 0 (+Z local -> heading):
  // roadPointAt with +leftOffset moves along (-uz, +ux), so road from building is (+uz, -ux) = heading - PI/2
  const towardRoadHeading = Math.atan2(diagMain.uz, -diagMain.ux);
  const monumentalDiag = {
    id: "monumental-diag-tower-0",
    type: "static",
    kind: "building",
    architecture: "boulevard",
    x: bPos.x,
    z: bPos.z,
    width: 48,
    length: 32,
    height: 50,
    heading: towardRoadHeading,
  };
  const monumentalMax = {
    id: "monumental-ortho-tower-1",
    type: "static",
    kind: "building",
    architecture: "boulevard",
    x: -60 + 13 / 2 + 4 + 17,
    z: 140,
    width: 52,
    length: 34,
    height: 56,
    heading: -Math.PI / 2,
  };
  const parked = roadPointAt(diagMain, 180, -(diagMain.width / 2 - 1.3));
  const parkedCar = {
    id: "diag-parked-0",
    type: "static",
    kind: "parked-vehicle",
    vehicleKind: "sedan",
    x: parked.x,
    z: parked.z,
    width: 1.9,
    length: 4.5,
    height: 1.5,
    heading: diagMain.heading,
  };
  const start = roadPointAt(diagMain, 190, 2.7);
  const player = {
    id: "player",
    type: "vehicle",
    kind: "suv",
    x: start.x,
    z: start.z,
    heading: diagMain.heading,
    speed: 0,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    height: PLAYER_VEHICLE.heightM,
    path: [{ x: start.x, z: start.z }, roadPointAt(diagMain, 260, 2.7)],
  };
  const drivingRoads = [diagMain, orthoCross, slashLocal];
  return {
    environment: "metro",
    config: { cityVersion: 5 },
    drivingRoads,
    roads: drivingRoads,
    statics: [monumentalDiag, monumentalMax, parkedCar],
    actors: [player],
    player,
    sensors: {},
    routeRevision: 0,
    tick: 0,
    diagMain,
    monumentalDiag,
  };
}

test("WorldView and EgyptStreetLayer render diagonal v5 avenues, curbs, crosswalks, and 50m+ buildings within budget", (t) => {
  const world = makeSyntheticV5World();
  assert.equal(usesCityV4StreetFinish(world), true);
  assert.equal(usesCityV4StreetFinish({ environment: "metro", config: { cityVersion: 4 } }), true);
  assert.equal(usesCityV4StreetFinish({ environment: "metro", config: { cityVersion: 3 } }), false);

  const eagerLayer = createEgyptStreetLayer(world);
  const view = new WorldView(world);
  t.after(() => {
    eagerLayer.dispose();
    view.dispose();
  });

  // Verify v5 budget & monumental floor scaling
  assert.equal(eagerLayer.diagnostics.budget.maxTriangles, 260000);
  assert.equal(eagerLayer.diagnostics.budget.maxDrawCalls, 75);
  assert.equal(eagerLayer.diagnostics.budget.withinBudget, true);
  assert.ok(eagerLayer.diagnostics.counts.curbSegments > 0, "diagonal streets must emit 3D curb segments");
  assert.ok(eagerLayer.diagnostics.counts.drains > 0, "diagonal avenues must emit storm drains");
  assert.ok(eagerLayer.diagnostics.counts.forecourtSlabs > 0, "diagonal streets must emit forecourt slabs");

  const diagTowerInfo = eagerLayer.diagnostics.sites.find((s) => s.id === "monumental-diag-tower-0");
  const maxTowerInfo = eagerLayer.diagnostics.sites.find((s) => s.id === "monumental-ortho-tower-1");
  assert.ok(diagTowerInfo && maxTowerInfo);
  assert.equal(diagTowerInfo.facingRoadId, "nile-diagonal-avenue",
    "diagonal-aligned building must orient primary shopfront/signage toward the diagonal avenue");
  assert.equal(diagTowerInfo.primaryFace, 0);
  assert.ok(diagTowerInfo.upperFloors >= 10 && diagTowerInfo.upperFloors <= 16);
  assert.ok(maxTowerInfo.upperFloors >= 12 && maxTowerInfo.upperFloors <= 16);

  // Streamed residency inside WorldView stays within budget too
  view.sync(1);
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  cam.position.set(world.player.x - 10, 5, world.player.z - 10);
  view.prepareFrame({ cameras: [cam] });
  assert.equal(view.egyptStreets.diagnostics.budget.withinBudget, true);
  assert.ok(view.egyptStreets.diagnostics.counts.curbSegments > 0);
  assert.ok(view.egyptStreets.diagnostics.counts.shops > 0);

  // Verify expanded v5 ground (>= 2600 x 2600) and fog (120..460)
  assert.equal(view.scene.fog.near, 120);
  assert.equal(view.scene.fog.far, 460);
  const groundMesh = view.scene.children.find(
    (obj) => obj.isMesh && obj.geometry?.type === "PlaneGeometry",
  );
  assert.ok(groundMesh, "ground plane exists");
  assert.ok(groundMesh.geometry.parameters.width >= 2600);
  assert.ok(groundMesh.geometry.parameters.height >= 2600);

  // Verify road-markings exist (rotated center dashes + zebra crosswalks) and skip intersections
  const markings = view.scene.getObjectByName("road-markings");
  assert.ok(markings && markings.geometry.attributes.position.count > 0);

  // Verify metroGroundHeight & actual 3D road/pavement mesh raycasts on diagonal street
  const { diagMain } = world;
  const onAsphalt = roadPointAt(diagMain, 300, 2.0);
  const onSidewalk = roadPointAt(diagMain, 300, diagMain.width / 2 + 1.4);
  // Point inside diagMain's AABB but far laterally off the diagonal road & sidewalk
  const offRoadInAABB = roadPointAt(diagMain, 300, 45);

  assert.equal(view.metroGroundHeight(onAsphalt.x, onAsphalt.z), 0.115);
  assert.equal(view.metroGroundHeight(onSidewalk.x, onSidewalk.z), 0.07);
  assert.equal(view.metroGroundHeight(offRoadInAABB.x, offRoadInAABB.z), -0.05);

  view.scene.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.set(new THREE.Vector3(onAsphalt.x, 5, onAsphalt.z), new THREE.Vector3(0, -1, 0));
  const roadHit = raycaster.intersectObjects(view.surfaces.road, false)[0];
  assert.ok(roadHit && Math.abs(roadHit.point.y - 0.115) < 1e-6, "diagonal asphalt mesh top is at y = 0.115");

  raycaster.set(new THREE.Vector3(onSidewalk.x, 5, onSidewalk.z), new THREE.Vector3(0, -1, 0));
  const sidewalkHit = raycaster.intersectObjects(view.surfaces.pavement, false)[0];
  assert.ok(sidewalkHit && Math.abs(sidewalkHit.point.y - 0.07) < 1e-6, "diagonal sidewalk mesh top is at y = 0.07");
});

test("full Grand Metro City v5 map builds cleanly in EgyptStreetLayer and WorldView within budget", (t) => {
  const grandMap = createUnifiedCity({ grand: true });
  const player = {
    id: "player",
    type: "vehicle",
    kind: "suv",
    ...grandMap.playerStart,
    speed: 8,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    height: PLAYER_VEHICLE.heightM,
    path: [grandMap.playerStart],
  };
  const world = {
    ...grandMap,
    environment: "metro",
    config: { cityVersion: 5 },
    actors: [player],
    player,
    sensors: {},
    routeRevision: 0,
    tick: 0,
  };
  const eager = createEgyptStreetLayer(world);
  const view = new WorldView(world);
  t.after(() => {
    eager.dispose();
    view.dispose();
  });

  assert.equal(eager.diagnostics.budget.withinBudget, true,
    `eager v5 within budget: draws=${eager.diagnostics.drawCalls}, tris=${eager.diagnostics.triangles}`);
  assert.ok(eager.diagnostics.counts.curbSegments > 100);

  view.sync(1);
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  cam.position.set(player.x - 14, 6.5, player.z - 8);
  view.prepareFrame({ cameras: [cam] });
  assert.equal(view.egyptStreets.diagnostics.budget.withinBudget, true,
    `streamed v5 within budget: draws=${view.egyptStreets.diagnostics.drawCalls}, tris=${view.egyptStreets.diagnostics.triangles}`);
  assert.ok(view.metroDiagRoads.length >= 4);
  const diag = view.metroDiagRoads[0];
  const midAsphalt = roadPointAt(diag, diag.length * 0.5, 0);
  assert.equal(view.metroGroundHeight(midAsphalt.x, midAsphalt.z), 0.115);
});

function pointStrictlyInsideBuilding(point, site) {
  const dx = point.x - site.x, dz = point.z - site.z;
  const c = Math.cos(site.heading ?? 0), s = Math.sin(site.heading ?? 0);
  const localX = dx * c - dz * s;
  const localZ = dx * s + dz * c;
  const lowY = site.y ?? 0.12;
  const highY = lowY + site.height;
  return Math.abs(localX) < site.width / 2 - 1e-4 &&
    Math.abs(localZ) < site.length / 2 - 1e-4 &&
    point.y > lowY + 1e-4 &&
    point.y < highY - 1e-4;
}

test("createPursuitCamera distinguishes follow vs chasing styles and never clips inside 52x34x48m buildings", () => {
  const followCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  const chasingCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  const autoCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);

  const followCtrl = createPursuitCamera();
  const chasingCtrl = createPursuitCamera();
  const autoCtrl = createPursuitCamera();

  const carPos = new THREE.Vector3(0, 0.12, 0);
  const openInput = {
    position: carPos,
    heading: 0,
    speedMps: 12.5,
    streetWidthM: 14,
    deltaS: 1 / 60,
    snap: true,
  };

  followCtrl.update(followCam, { ...openInput, cameraStyle: "follow" });
  chasingCtrl.update(chasingCam, { ...openInput, cameraStyle: "chasing" });
  autoCtrl.update(autoCam, openInput);

  // Follow camera: closer, lower, zero lateral shoulder, standard 62 deg FOV
  assert.ok(Math.abs(followCam.position.x - carPos.x) < 1e-6, "follow style has shoulder === 0");
  assert.equal(followCam.fov, 62);

  const followBackDist = carPos.z - followCam.position.z;
  const chasingBackDist = carPos.z - chasingCam.position.z;
  assert.ok(followBackDist > 8 && followBackDist < 11.2, `follow back=${followBackDist}`);
  assert.ok(chasingBackDist > 18, `chasing is wider back=${chasingBackDist}`);
  assert.ok(Math.abs(chasingCam.position.x - carPos.x) > 1.0, "chasing uses lateral shoulder on wide avenues");
  assert.ok(chasingCam.position.y > followCam.position.y + 3.0, "chasing sits higher than follow");
  assert.ok(chasingCam.fov > 66 && chasingCam.fov <= 68, `chasing widens FOV at speed (${chasingCam.fov})`);

  // Switching same controller back from chasing to follow restores base FOV cleanly
  chasingCtrl.update(chasingCam, { ...openInput, cameraStyle: "follow", snap: true });
  assert.equal(chasingCam.fov, 62);
  assert.ok(Math.abs(chasingCam.position.x - carPos.x) < 1e-6);

  // Occlusion safety against monumental 52 m x 34 m x 48 m buildings (half-diagonal ~31.06 m > legacy 16 m margin!)
  // Place building behind/beside car so center is > 28 m from car while wall is only 3.2 m behind car!
  const giantBehind = {
    id: "monumental-block-behind",
    kind: "building",
    x: 22,
    z: -20.2,
    y: 0.12,
    width: 52,
    length: 34,
    height: 48,
    heading: 0,
  };
  const giantDiag = {
    id: "monumental-block-diag",
    kind: "building",
    x: -24,
    z: 18,
    y: 0.12,
    width: 52,
    length: 34,
    height: 48,
    heading: Math.PI / 5,
  };
  const staticIndex = new SpatialIndex([giantBehind, giantDiag]);

  for (const style of ["follow", "chasing", "auto"]) {
    const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
    const ctrl = createPursuitCamera();
    const pos = new THREE.Vector3(0, 0.12, 0);
    let heading = 0;

    ctrl.update(cam, {
      position: pos,
      heading,
      speedMps: 11,
      streetWidthM: 14,
      staticIndex,
      deltaS: 1 / 60,
      snap: true,
      cameraStyle: style,
    });
    assert.ok(!pointStrictlyInsideBuilding(cam.position, giantBehind),
      `${style} snap must never place camera inside 52x34x48m building (${JSON.stringify(cam.position)})`);
    assert.ok(cam.position.z > -3.2,
      `${style} camera stops in front of the monumental wall at z=-3.2 (got z=${cam.position.z})`);

    // Sweep 90 frames turning and driving past both monumental buildings
    const sample = new THREE.Vector3();
    for (let tick = 0; tick < 90; tick++) {
      const prev = cam.position.clone();
      heading += 0.035;
      pos.x += Math.sin(heading) * 0.16;
      pos.z += Math.cos(heading) * 0.16;
      ctrl.update(cam, {
        position: pos,
        heading,
        speedMps: 11.5,
        streetWidthM: 14,
        staticIndex,
        deltaS: 1 / 60,
        snap: false,
        cameraStyle: style,
      });
      for (let s = 1; s <= 16; s++) {
        sample.lerpVectors(prev, cam.position, s / 16);
        assert.ok(!pointStrictlyInsideBuilding(sample, giantBehind),
          `${style} sweep entered giantBehind at tick ${tick}`);
        assert.ok(!pointStrictlyInsideBuilding(sample, giantDiag),
          `${style} sweep entered giantDiag at tick ${tick}`);
      }
    }
  }
});

test("pako-rollouts 2D map draws diagonal roads from (x1,z1) to (x2,z2) without AABB fill or NaN", () => {
  const ops = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    fillRect(...args) { ops.push(["fillRect", ...args]); },
    beginPath() { ops.push(["beginPath"]); },
    moveTo(...args) { ops.push(["moveTo", ...args]); },
    lineTo(...args) { ops.push(["lineTo", ...args]); },
    stroke() { ops.push(["stroke", this.strokeStyle, this.lineWidth]); },
    setLineDash() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    roundRect() {},
    fill() {},
    arc() {},
    closePath() {},
    fillText() {},
  };
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    width: 400,
    height: 300,
    open: true,
    value: "",
    max: "0",
    disabled: false,
    textContent: "",
    options: [{ value: "" }],
    append(opt) { this.options.push(opt); },
    remove(idx) { this.options.splice(idx, 1); },
    setAttribute() {},
    addEventListener() {},
    closest() { return null; },
    getContext() { return ctx; },
  });
  for (const id of [
    "pakoGhostFleet", "pakoGhostMap", "pakoGhostSummary", "pakoGhostFocus",
    "pakoGhostPlay", "pakoGhostStep", "pakoGhostSpeed", "pakoGhostTime",
    "pakoGhostExport", "pakoGhostCamera",
  ]) elements.set(id, makeEl(id));
  const doc = {
    getElementById: (id) => elements.get(id),
    createElement: () => ({ value: "", textContent: "" }),
  };

  const diag = makeDiagonalRoad({
    id: "ramses-diagonal",
    x1: -100,
    z1: -80,
    x2: 140,
    z2: 110,
    width: 13,
  });
  const ortho = { id: "tahrir", axis: "x", fixed: -80, min: -100, max: 140, width: 14 };
  const playback = mountRolloutPlayback(doc, [diag, ortho]);
  ops.length = 0;
  playback.add({
    id: "ep-1",
    phase: "escaped",
    collisions: 0,
    trajectory: [
      [0, -90, -72, 8, diag.heading],
      [10, 20, 15, 9, diag.heading],
    ],
  }, 1);

  const numericCoords = ops
    .filter(([kind]) => kind === "moveTo" || kind === "lineTo" || kind === "fillRect")
    .flatMap(([, ...nums]) => nums);
  assert.ok(numericCoords.length > 0);
  assert.ok(numericCoords.every((n) => Number.isFinite(n)), "all 2D rollout coordinates must be finite numbers");
  const fillRects = ops.filter(([kind]) => kind === "fillRect");
  // Background (1) + orthogonal road (1) + 1 car's 4 wheels & 1 windshield (5) + scale bar (1) = 8;
  // diagonal road uses stroke from (x1,z1) to (x2,z2), never an AABB fillRect.
  assert.equal(fillRects.length, 8);
  const strokes = ops.filter(([kind]) => kind === "stroke");
  assert.ok(strokes.some(([, color, width]) => color === "#273a40" && width > 5),
    "diagonal road ribbon is stroked with scaled road width");
});
