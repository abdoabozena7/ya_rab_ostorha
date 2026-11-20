import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createEgyptDistrict } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance, overlaps, roadRect } from "../src/core/geometry.js";
import { walkSegmentClear } from "../src/core/walk-route.js";
import { STEP } from "../src/core/config.js";
import { createDistrictCase, DISTRICT_CASES } from "../src/core/district-scenarios.js";
import { getVehicleMounts, mountToWorld } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { createDistrictProps } from "../src/render/district-props.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";

const car = { type: "vehicle", length: 4.2, width: 1.85 };
const person = { type: "pedestrian", radius: 0.38 };
const rectangle = (zone) => ({
  x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
  width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
});

function frontCameraVisibility(ego, actor, occluder, wholeBody = false) {
  const mount = getVehicleMounts(ego).camera, position = mountToWorld(ego, mount.position);
  const origin = new THREE.Vector3(position.x, position.y, position.z);
  const hull = new THREE.Box3(
    new THREE.Vector3(occluder.x - occluder.width / 2, 0.12, occluder.z - occluder.length / 2),
    new THREE.Vector3(occluder.x + occluder.width / 2, 0.12 + occluder.height, occluder.z + occluder.length / 2),
  );
  assert.equal(occluder.heading, 0);
  const heading = ego.heading + mount.angleDeg * Math.PI / 180;
  const c = Math.cos(heading), s = Math.sin(heading);
  const focal = 360 / (2 * Math.tan(76 * Math.PI / 360));
  const offsets = wholeBody
    ? Array.from({ length: 32 }, (_, i) => ({
      x: actor.radius * Math.cos(i * Math.PI / 16),
      z: actor.radius * Math.sin(i * Math.PI / 16),
    }))
    : [-1, 0, 1].map((side) => ({ x: side * actor.radius * c, z: -side * actor.radius * s }));
  let inFrame = 0, hidden = 0;
  for (const offset of offsets)
    for (const height of wholeBody ? [0, .15, .5, .75, 1] : [.15, .5, 1]) {
      const point = new THREE.Vector3(actor.x + offset.x, .12 + actor.body.heightM * height, actor.z + offset.z);
      const dx = point.x - origin.x, dz = point.z - origin.z, depth = dx * s + dz * c;
      if (depth <= .01) continue;
      const x = 320 - (dx * c - dz * s) * focal / depth;
      const y = 180 - (point.y - origin.y) * focal / depth;
      if (x < 0 || x > 640 || y < 0 || y > 360) continue;
      inFrame++;
      const ray = new THREE.Ray(origin, point.clone().sub(origin).normalize());
      const hit = ray.intersectBox(hull, new THREE.Vector3());
      if (hit && hit.distanceTo(origin) < point.distanceTo(origin) - 1e-8) hidden++;
    }
  return { inFrame, hidden, visible: inFrame - hidden,
    aheadM: (actor.x - position.x) * s + (actor.z - position.z) * c };
}

test("the literal district gives the real default population clear bodies, no intersecting statics, and diverse walkable starts", () => {
  const district = createEgyptDistrict(), copy = createEgyptDistrict();
  assert.deepEqual(district, copy);
  district.playerStart.x++;
  assert.notDeepEqual(district, copy, "Every world owns fresh profile objects");
  const allCars = [{ ...car, ...copy.playerStart },
    ...copy.trafficSpawns.map((p, i) => ({ ...car, id: `car-${i}`, ...p }))];
  assert.ok(copy.trafficSpawns.length >= 28);
  assert.ok(copy.pedestrianSpawns.length >= 32);
  for (const [i, body] of allCars.entries()) {
    assert.ok(bodyOnRoad(body, copy.roads, 0.12), `car ${i} body on registered road`);
    assert.ok(!copy.statics.some((other) => overlaps(body, other, 0.12)), `car ${i} clear of statics`);
    assert.ok(!allCars.slice(i + 1).some((other) => overlaps(body, other, 0.12)), `car ${i} nonoverlap`);
  }
  for (const [i, site] of copy.statics.entries())
    assert.ok(!copy.statics.slice(i + 1).some((other) => overlaps(site, other, 0.12)),
      `${site.id} registered static footprints must not intersect`);
  for (const spawn of copy.pedestrianSpawns) {
    const body = { ...person, ...spawn };
    assert.ok(!copy.statics.some((other) => overlaps(body, other, 0.12)), spawn.walkwayId);
    assert.ok(!allCars.some((other) => overlaps(body, other, 0.12)), spawn.walkwayId);
  }
  const populatedRoads = new Set(copy.pedestrianSpawns.slice(0, 32).map((p) => p.roadId));
  assert.equal(populatedRoads.size, copy.drivingRoads.length, "Default people include actual alleys, not just the first road");
});

test("every declared walkway and doorway is continuously clear for the largest ordinary human body", () => {
  const district = createEgyptDistrict();
  for (const walkway of district.walkways) {
    const at = (along) => walkway.axis === "z"
      ? { x: walkway.fixed, z: along } : { x: along, z: walkway.fixed };
    assert.ok(walkSegmentClear(person, at(walkway.min), at(walkway.max), district.statics, 0.12),
      `${walkway.id} is not a continuous actual walkline`);
  }
  for (const anchor of district.caseAnchors) {
    const isVehicle = anchor.matrixCase === "two-car-narrow-passage";
    for (const pose of [anchor.actorStart, anchor.actorTarget])
      assert.ok(!district.statics.some((s) => overlaps({ ...(isVehicle ? car : person), ...pose }, s, 0.12)),
        `${anchor.id}: actor anchor is inside ${JSON.stringify(pose)}`);
    assert.ok(bodyOnRoad({ ...car, ...anchor.playerStart }, district.roads, 0.12), anchor.id);
  }
});

test("stationary and parallel lookalikes leave the unchanged independent 0.3m vehicle probe genuinely clear", () => {
  const district = createEgyptDistrict();
  for (const id of ["stationary-curb", "parallel-away"]) {
    const anchor = district.caseAnchors.find((a) => a.id === id);
    for (const pose of [anchor.actorStart, anchor.actorTarget]) {
      const passing = { ...car, x: anchor.playerStart.x, z: pose.z, heading: anchor.playerStart.heading };
      assert.equal(overlaps(passing, { ...person, ...pose }, 0.3), false,
        `${id} must not use a permanently frozen physical baseline`);
      assert.ok(district.walkways.some((walkway) => walkway.axis === "z"
        && Math.abs(walkway.fixed - pose.x) < 1e-8 && pose.z >= walkway.min && pose.z <= walkway.max),
      `${id} uses a real declared clear curb walkline`);
    }
  }
});

test("the hidden case starts behind the registered van and ordinary World motion emerges ahead before crossing and clearing", () => {
  const world = new World({
    seed: "district-dev-a", districtCase: "fully-hidden-emergence", traffic: 0, pedestrians: 0,
  }, "egypt");
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "district-run" });
  const actor = world.actors.find((a) => a.type === "pedestrian");
  const van = world.statics.find((s) => s.id === world.districtCase.occluderId);
  const initial = { ...actor };
  const startView = frontCameraVisibility(world.player, actor, van, true);
  assert.equal(startView.inFrame, 160, "The whole neutral body must be in the actual 640x360, 76-degree front frustum");
  assert.equal(startView.hidden, startView.inFrame, "A waiting body must not peek around either van edge");
  const oldView = frontCameraVisibility(world.player, { ...actor, x: -7.5, z: -18.7 }, van, true);
  assert.ok(oldView.visible > 0, "The old initially peeking anchor is a genuine negative control");
  assert.equal(walkSegmentClear(actor, actor, actor.target, world.statics, .12), false,
    "The ordinary route must really walk around the van, not start beyond it");
  let firstVisible = null, fullyVisible = null, entry = null, cleared = null;
  for (let tick = 0; tick < 20 / STEP && world.districtCase.phase !== "complete"; tick++) {
    const previous = { ...actor }, oldEgo = { ...world.player };
    world.step();
    assert.deepEqual(world.audit(), []);
    assert.ok(bodyOnRoad(world.player, world.roads, .12));
    assert.ok(walkSegmentClear(actor, previous, actor, [...world.statics, oldEgo, world.player], .12),
      `Continuous body-radius+.12 clearance at tick ${world.tick}`);
    const moved = distance(previous, actor);
    assert.ok(Math.abs(actor.distance - previous.distance - moved) < 1e-8);
    assert.ok(Math.abs(moved - actor.speed * STEP) < 1e-8);
    assert.ok(actor.speed - previous.speed <= 2.5 * STEP + 1e-8);
    assert.ok(previous.speed - actor.speed <= 3.5 * STEP + 1e-8);
    assert.ok(Math.abs(angleDelta(actor.heading, previous.heading)) <= 3 * STEP + 1e-8);
    const view = frontCameraVisibility(world.player, actor, van);
    const at = { timeS: world.tick * STEP, pose: { x: actor.x, z: actor.z }, ...view };
    if (view.visible && !firstVisible) firstVisible = at;
    if (view.visible === 9 && !fullyVisible) fullyVisible = at;
    const lateral = actor.x - world.districtCase.playerStart.x;
    const halfCorridor = world.player.width / 2 + actor.radius;
    if (Math.abs(lateral) <= halfCorridor && !entry) entry = at;
    if (entry && lateral < -halfCorridor && !cleared) cleared = at;
  }
  assert.ok(firstVisible?.timeS > 0 && distance(initial, firstVisible.pose) > .05);
  assert.ok(firstVisible.aheadM > world.player.length / 2,
    "Emergence must be ahead of the actual camera, not an already-past crossing");
  assert.ok(fullyVisible && fullyVisible.timeS < entry?.timeS && fullyVisible.aheadM > 3);
  assert.ok(entry && cleared && entry.timeS < cleared.timeS && entry.aheadM > 0 && cleared.aheadM > 0);
  assert.equal(actor.district.caseStage, "complete");
  assert.equal(world.districtCase.phase, "complete");
  assert.ok(world.districtCase.triggerObservedAlongM >= world.districtCase.triggerEgoAlongM);
});

test("hidden and empty factories retain matched construction and do not mutate any other authored case", () => {
  const district = createEgyptDistrict(), before = structuredClone(district);
  const others = DISTRICT_CASES.filter(({ id }) =>
    !["ambient", "fully-hidden-emergence", "same-occluder-empty"].includes(id));
  const factories = others.map(({ id }) => createDistrictCase(district, id, "district-dev-a"));
  const hidden = createDistrictCase(district, "fully-hidden-emergence", "district-dev-a");
  const empty = createDistrictCase(district, "same-occluder-empty", "district-dev-a");
  for (const field of ["playerStart", "goal", "requestedSpeedMps", "triggerEgoAlongM", "occluderId", "caseRngState"])
    assert.deepEqual(hidden[field], empty[field], field);
  assert.equal(hidden.people.length, 1);
  assert.equal(empty.people.length, 0);
  assert.deepEqual(others.map(({ id }) => createDistrictCase(district, id, "district-dev-a")), factories);
  assert.deepEqual(district, before);
  const hiddenWorld = new World({ seed: "district-dev-a", districtCase: hidden.id }, "egypt");
  const emptyWorld = new World({ seed: "district-dev-a", districtCase: empty.id }, "egypt");
  assert.deepEqual(hiddenWorld.player, emptyWorld.player);
  for (const field of ["roads", "statics", "cautionZones", "playerStart", "trafficSpawns", "pedestrianSpawns"])
    assert.deepEqual(hiddenWorld.district[field], emptyWorld.district[field], field);
});

test("two genuine narrow continuous spans survive all registered mouths and bounded resources provide legal separate waiting storage", () => {
  const district = createEgyptDistrict();
  const alleys = district.drivingRoads.filter((r) => r.width >= 3.2 && r.width <= 4);
  assert.equal(alleys.length, 2);
  for (const alley of alleys) {
    assert.equal(alley.marking, "none");
    const mouths = district.roads.filter((r) => r.supportApron && r.fixed === alley.fixed)
      .map((r) => roadRect(r)).sort((a, b) => a.minZ - b.minZ);
    assert.ok(mouths[1].minZ - mouths[0].maxZ >= 12,
      `${alley.id} must not be widened away by overlapping aprons`);
  }
  for (const support of district.roads.filter((r) => r.supportApron)) {
    const b = roadRect(support);
    assert.ok(b.maxZ - b.minZ <= 12 && b.maxX - b.minX <= 12);
  }
  for (const [i, zone] of district.conflictZones.entries()) {
    assert.ok(zone.approachM >= car.length + 1);
    for (const other of district.conflictZones.slice(i + 1))
      assert.equal(overlaps(rectangle(zone), rectangle(other)), false, `${zone.id}/${other.id}`);
    for (const spot of zone.waitingSpots ?? []) {
      assert.ok(bodyOnRoad({ ...car, ...spot }, district.roads, 0.12));
      assert.equal(overlaps({ ...car, ...spot }, rectangle(zone), 0.12), false,
        "Waiting occupies a real separate approach, not the resource's exit");
    }
  }
  const empty = district.caseAnchors.find((a) => a.id === "same-occluder-empty");
  const hidden = district.caseAnchors.find((a) => a.id === "fully-hidden-emergence");
  for (const field of ["playerStart", "goal", "actorStart", "actorTarget", "occluderId", "triggerEgoAlongM"])
    assert.deepEqual(empty[field], hidden[field], `Empty twin preserves ${field}`);
});

test("the Egyptian facade layer activates on the registered district and keeps its actual vertices inside physical building footprints", () => {
  const district = createEgyptDistrict();
  const layer = createEgyptStreetLayer({ ...district, environment: "egypt" });
  assert.ok(layer.diagnostics.active && layer.diagnostics.budget.withinBudget);
  assert.equal(layer.diagnostics.siteIds.length, district.statics.filter((s) => s.kind === "building").length);
  assert.ok(layer.diagnostics.counts.shops > 40 && layer.diagnostics.counts.balconies > 20);
  const sites = new Map(district.statics.map((s) => [s.id, s]));
  layer.root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.attributes.position, indices = mesh.geometry.attributes.siteIndex;
    for (let i = 0; i < positions.count; i++) {
      const index = indices.getX(i);
      if (index < 0) continue;
      const site = sites.get(layer.diagnostics.siteIds[index]);
      assert.ok(Math.abs(positions.getX(i) - site.x) <= site.width / 2 + 0.00002, site.id);
      assert.ok(Math.abs(positions.getZ(i) - site.z) <= site.length / 2 + 0.00002, site.id);
      assert.ok(positions.getY(i) <= site.height + 0.12002, site.id);
    }
  });
  layer.dispose();
});

test("real existing parked minivan/saloon assets are fitted to their registered silhouettes through injected cached-asset callbacks", async () => {
  const district = createEgyptDistrict(), calls = [], templates = [];
  const props = createDistrictProps({ ...district, environment: "egypt" }, {
    assetFor(actor, environment) {
      assert.equal(environment, "egypt");
      return actor.kind === "van" ? "traffic-minivan.glb" : "traffic-saloon.glb";
    },
    async loadAsset(name) {
      const bytes = readFileSync(resolve("assets", "models", "vehicles", name));
      const gltf = await new GLTFLoader().parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
      templates.push(gltf.scene); return gltf;
    },
    fit(template, width, length, height, matchHull) {
      calls.push({ width, length, height, matchHull });
      return template.clone(true);
    },
  });
  await props.ready;
  assert.equal(props.diagnostics.failed.length, 0);
  assert.equal(props.diagnostics.loaded, 2);
  assert.ok(calls.every((call) => call.matchHull === true));
  props.root.updateMatrixWorld(true);
  for (const site of district.statics.filter((s) => s.kind === "parked-vehicle")) {
    const group = props.root.getObjectByName(site.id);
    const measured = new THREE.Box3().setFromObject(group);
    const hx = (Math.abs(Math.cos(site.heading)) * site.width + Math.abs(Math.sin(site.heading)) * site.length) / 2;
    const hz = (Math.abs(Math.sin(site.heading)) * site.width + Math.abs(Math.cos(site.heading)) * site.length) / 2;
    assert.ok(Math.abs(measured.min.x - (site.x - hx)) <= 0.15);
    assert.ok(Math.abs(measured.max.x - (site.x + hx)) <= 0.15);
    assert.ok(Math.abs(measured.min.z - (site.z - hz)) <= 0.15);
    assert.ok(Math.abs(measured.max.z - (site.z + hz)) <= 0.15);
    assert.ok(Math.abs(measured.max.y - (0.12 + site.height)) <= 0.001);
  }
  let templateDisposals = 0;
  templates.forEach((root) => root.traverse((part) => {
    if (part.isMesh) part.geometry.addEventListener("dispose", () => templateDisposals++);
  }));
  props.dispose(); props.dispose();
  assert.equal(templateDisposals, 0, "Shared cached asset geometry is not owned by the district");
  assert.equal(props.root.children.length, 0);
  const city = createDistrictProps({ environment: "city", statics: district.statics });
  assert.equal(city.diagnostics.active, false);
  assert.equal(city.root.children.length, 0);
  city.dispose();
});

test("missing and late cached assets remain explicit and cannot remove a parked physical silhouette or resurrect a disposed layer", async () => {
  const world = { environment: "egypt", statics: [createEgyptDistrict().statics.find((s) => s.kind === "parked-vehicle")] };
  const failed = createDistrictProps(world, {
    loadAsset: async () => { throw new Error("local model missing"); },
    fit: () => { throw new Error("unreachable"); }, assetFor: () => "existing-local-asset",
  });
  await failed.ready;
  assert.equal(failed.diagnostics.loaded, 0);
  assert.match(failed.diagnostics.failed[0].error, /local model missing/);
  failed.root.updateMatrixWorld(true);
  const silhouette = new THREE.Box3().setFromObject(failed.root);
  assert.ok(Math.abs(silhouette.max.x - silhouette.min.x - world.statics[0].width) < 0.001);
  assert.ok(Math.abs(silhouette.max.z - silhouette.min.z - world.statics[0].length) < 0.001);
  failed.dispose();
  let release;
  const late = createDistrictProps(world, {
    loadAsset: () => new Promise((resolveAsset) => { release = resolveAsset; }),
    fit: () => { throw new Error("must not fit after dispose"); }, assetFor: () => "existing-local-asset",
  });
  await Promise.resolve();
  late.dispose();
  release({ scene: new THREE.Group() });
  await late.ready;
  assert.equal(late.root.children.length, 0);
  assert.equal(late.diagnostics.loaded, 0);
  assert.equal(late.diagnostics.failed.length, 0);
});
