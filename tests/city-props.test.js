import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { World } from "../src/core/world.js";
import { overlaps } from "../src/core/geometry.js";
import { CITY_PROP_PROFILE, cityPropVisualState, resetCityPropImpacts } from "../src/core/city-props.js";
import { createCityPropsView } from "../src/render/city-props-view.js";

const create = options => new World({ cityVersion: 5, seed: "solid-city-props", traffic: 0, pedestrians: 0, ...options }, "metro");

function stage(world, site, speed, grazing = false) {
  const p = world.player, heading = grazing ? -.16 : 0;
  Object.assign(p, {
    x: site.x + (grazing ? site.width / 2 + p.width / 2 * Math.cos(heading) +
      p.length / 2 * Math.abs(Math.sin(heading)) + .005 : 0),
    z: site.z - (grazing ? p.length / 2 : 6),
    heading, speed, steer: 0,
  });
  if (world.pursuit) world.pursuit.manualAction = { steer: 0, throttle: 1, brake: 0, gear: 1 };
  else world.command({ type: "drive", targetSpeed: speed, steer: 0 });
}

function impact(world, kind, speed, grazing = false) {
  const site = kind === "city-tree" ? world.statics.find(s => s.id === "city-tree-4")
    : world.statics.find(s => s.kind === kind);
  assert.ok(site);
  stage(world, site, speed, grazing);
  assert.equal(world.statics.some(s => overlaps(world.player, s)), false,
    "controlled impact must begin outside every existing static hull");
  const start = { x: world.player.x, z: world.player.z };
  const hull = { x: site.x, z: site.z, width: site.width, length: site.length };
  let contact = null;
  let outgoingSpeed = null;
  for (let i = 0; i < 60; i++) {
    world.step();
    assert.equal(overlaps(world.player, site), false, `penetration on tick ${world.tick}`);
    if (contact === null && world.player.vehicle?.contact?.hitId === site.id) {
      contact = world.player.vehicle.contact;
      outgoingSpeed = world.player.speed;
    }
  }
  assert.ok(contact, `actual ${kind} contact is required, not an earlier safety stop`);
  assert.ok(world.player.vehicle.damage.total > 0, "contact must reach vehicle damage");
  assert.ok(site.propImpact.hits > 0);
  assert.ok(site.propImpact.damage > 0 && site.propImpact.damage <= 1);
  assert.deepEqual({ x: site.x, z: site.z, width: site.width, length: site.length }, hull);
  assert.ok(world.staticIndex.matchesItems(world.statics), "damage must not invalidate broadphase geometry");
  if (grazing) {
    assert.ok(Math.abs(contact.normal.x) > .9, "a real side contact rather than a frontal impact");
    assert.ok(world.player.z > start.z + 4, "glancing impact must retain tangential travel");
  } else {
    assert.ok(world.player.z > start.z + .2, "must actually drive before impact");
    assert.ok(world.player.z < site.z - site.length / 2, "must not emerge beyond prop");
    assert.ok(Math.abs(outgoingSpeed) < speed / 2, "head-on fixed obstacle must remove most forward speed");
  }
  return site;
}

test("City props retain old tree placement, static ownership, scanning and ambient population", () => {
  const world = create(), legacy = create({ cityPropProfile: "none" });
  const trees = world.statics.filter(s => s.kind === "city-tree");
  assert.ok(trees.length > 100);
  assert.equal(world.statics, world.district.statics);
  assert.equal(world.actors.length, legacy.actors.length);
  assert.deepEqual(world.statics.filter(s => !s.propImpact),
    legacy.statics.filter(s => s.kind !== "market-stall"));
  const t = trees[0];
  assert.equal(t.x, -511.45);
  assert.equal(t.z, -400);
  world.step();
  stage(world, t, 0);
  world.updateSensors();
  assert.ok(world.sensors.rays.some(ray => ray.hitId === t.id), "real mounted range sensor must see tree");
  assert.ok(world.staticIndex.near(t, 1).includes(t));
  world.player.z = t.z - 4;
  world.player.speed = 3;
  const planned = world.safeSpeed(world.player, { targetSpeed: 6, steer: 0 }, false);
  assert.equal(planned.blockedBy, t.id);
  assert.ok(planned.targetSpeed < 6, "autonomous planning must still avoid the real prop");
});

test("registered trees preserve physically clear default and maximum ambient populations", () => {
  for (const pedestrians of [190, 280]) {
    const world = create({ pedestrians, traffic: 68 });
    assert.equal(world.actors.filter(a => a.type === "pedestrian").length, pedestrians);
    assert.equal(world.actors.filter(a => a.type === "vehicle" && a !== world.player).length, 68);
    assert.deepEqual(world.audit(), []);
  }
});

for (const kind of ["city-tree", "market-stall"]) {
  for (const [label, speed, grazing] of [["head-on", 6, false], ["high-speed", 40, false], ["grazing", 14, true]]) {
    test(`ordinary City ${kind} ${label} has genuine nonpenetrating impact`, () => {
      impact(create(), kind, speed, grazing);
    });
    test(`Chase City ${kind} ${label} has genuine nonpenetrating impact`, () => {
      const world = create();
      world.command({ type: "street-pursuit-start", level: 1, variant: "gta",
        config: { ruleset: "dispatch-v1", curbSupport: "metro-city-curbs-v2" } });
      world.command({ type: "mode", mode: "manual" });
      impact(world, kind, speed, grazing);
    });
  }
}

test("legacy decorative-tree negative control crosses the same physical location", () => {
  const solid = create(), world = create({ cityPropProfile: "none" });
  const tree = solid.statics.find(s => s.kind === "city-tree");
  stage(world, tree, 14);
  for (let i = 0; i < 60; i++) world.step();
  assert.ok(world.player.z > tree.z + 4);
  assert.equal(world.player.vehicle.contact, null);
});

test("real contacts drive bounded visual damage, survive streaming and reset without changing hull", () => {
  const world = create(), scene = new THREE.Scene(), view = createCityPropsView(scene, world);
  for (const kind of ["city-tree", "market-stall"]) {
    const site = impact(world, kind, 14);
    const state = cityPropVisualState(world, site);
    assert.ok(Math.abs(state.bendX) <= .24 && Math.abs(state.bendZ) <= .24);
    assert.ok(state.crush >= 0 && state.crush <= .42);
    view.update([site]);
    const visual = view.root.getObjectByName(site.id), moving = visual.children.at(-1);
    assert.equal(visual.userData.staticId, site.id);
    assert.ok(kind === "city-tree" ? Math.abs(moving.rotation.x) > 0 : moving.scale.y < 1);
    view.update([{ x: 100000, z: 100000 }]);
    assert.equal(view.root.getObjectByName(site.id), undefined);
    assert.ok(world.staticIndex.near(site, 1).includes(site), "evicted mesh retains physical collider");
    view.update([site]);
    assert.equal(view.root.getObjectByName(site.id).userData.impactDamage, state.damage);
    resetCityPropImpacts(world);
    view.update([site]);
    const reset = view.root.getObjectByName(site.id).children.at(-1);
    assert.equal(reset.rotation.x, 0);
    assert.equal(reset.rotation.z, 0);
    assert.equal(reset.scale.y, 1);
  }
  view.dispose();
  assert.equal(view.root.parent, null);
});

test("paused prop updates avoid matrix uploads but impacts, animation, resets and mutable anchors invalidate them", () => {
  const world = create(), view = createCityPropsView(new THREE.Scene(), world);
  const site = world.statics.find(s => s.id === "city-tree-4");
  const anchor = { x: site.x, z: site.z };
  const batches = () => view.root.children.filter(part => part.isInstancedMesh);
  const versions = () => batches().map(batch => batch.instanceMatrix.version);
  view.update([anchor]);
  const initial = versions();
  assert.ok(initial.length > 0);
  for (let frame = 0; frame < 100; frame++) view.update([anchor]);
  assert.deepEqual(versions(), initial, "paused frames must not queue redundant GPU uploads");
  world.tick++;
  anchor.x += .001;
  view.update([anchor]);
  assert.deepEqual(versions(), initial, "unchanged visual state and residency need no upload even on a new tick");
  impact(world, "city-tree", 14);
  view.update([anchor]);
  const damaged = versions();
  assert.ok(damaged.some((version, index) => version > initial[index]));
  const data = batches().map(batch => Float32Array.from(batch.instanceMatrix.array));
  view.update([anchor]);
  assert.deepEqual(versions(), damaged);
  assert.deepEqual(batches().map(batch => batch.instanceMatrix.array), data);
  world.tick++;
  view.update([anchor]);
  const animated = versions();
  assert.ok(animated.some((version, index) => version > damaged[index]), "live bending must continue");
  resetCityPropImpacts(world);
  view.update([anchor]);
  assert.ok(versions().some((version, index) => version > animated[index]), "same-tick reset must invalidate damage");
  Object.assign(anchor, { x: 100000, z: 100000 });
  view.update([anchor]);
  assert.ok(batches().every(batch => batch.count === 0));
  Object.assign(anchor, { x: site.x, z: site.z });
  view.update([anchor]);
  assert.ok(batches().some(batch => batch.count > 0), "mutating a reused anchor must restore residency");
  for (const batch of batches()) {
    if (batch.count === 0) continue;
    assert.equal(batch.instanceMatrix.updateRange.count, batch.count * 16,
      "changed frames upload only the active instance prefix, not unused capacity");
  }
  view.dispose();
});

test("new prop profile replays deterministically while old recordings stay decorative", () => {
  const world = create();
  assert.equal(world.config.cityPropProfile, CITY_PROP_PROFILE);
  for (let i = 0; i < 8; i++) world.step();
  assert.deepEqual(World.fromReplay(world.replay()).snapshot(), world.snapshot());
  const old = world.replay();
  delete old.config.cityPropProfile;
  const restored = World.fromReplay(old);
  assert.equal(restored.config.cityPropProfile, "none");
  assert.equal(restored.statics.some(s => s.kind === "city-tree"), false);
  assert.throws(() => create({ cityPropProfile: "unknown" }), /prop profile/);
});
