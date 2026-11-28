import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { distance } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { CITY_FAIR_POLICE, CITY_PACK_PRESSURE, TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { gtaPatrolCommand } from "../src/core/pursuit-gta.js";
import { KING_LONG_MICROBUS_ID } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { selectSensorEscapeGoal } from "../src/rl/pako-smart-escape.js";
import { PURSUIT_SCAN_RAYS } from "../src/signal_processing/pursuit-scanner.js";

const config = {
  ruleset: "dispatch-v1", tacticalPursuit: TACTICAL_PURSUIT_MODE, policeFairness: CITY_FAIR_POLICE,
  cityPackPressure: CITY_PACK_PRESSURE, maxActivePatrols: 14, chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  curbSupport: METRO_CITY_CURBS,
};
const start = (world, options = config, level = 5) =>
  world.command({ type: "street-pursuit-start", level, variant: "gta", config: options });

test("the pressure pack rolls from legal positions, increases radio support and replays the same physical turns", () => {
  const world = new World({ cityVersion: 5, traffic: 12, pedestrians: 24 }, "metro");
  world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID });
  const civilians = [...world.actors];
  start(world);
  const { pursuit: run, player } = world, units = [...run.patrols];
  assert.ok(units.filter(unit => distance(unit, player) <= 65).length >= 3);
  assert.ok(units.every(unit => unit.maxSpeed <= player.maxSpeed));
  assert.deepEqual(world.audit(), [], "opening is supported and has no overlaps");
  world.command({ type: "pursuit-drive", action: { gear: 1, steer: 0, throttle: .55, brake: 0 } });
  const stages = new Set(), movingSupport = new Set();
  for (let i = 0; i < 390; i++) {
    world.step();
    stages.add(run.gta.pressure.stage);
    for (const unit of units) {
      assert.ok(distance(unit, unit.previous) <= 36 * STEP + .05, "patrol moves through the solver, not by teleport");
      if (unit.aiState === "RADIO_SUPPORT" && distance(unit, unit.previous) > .025)
        movingSupport.add(unit);
    }
  }
  assert.deepEqual([...stages], [0, 1, 2]);
  assert.ok(movingSupport.size >= 2, "distinct already deployed patrols actually took backup routes");
  assert.ok(civilians.every(actor => world.actors.includes(actor)));
  assert.deepEqual([...run.patrols], units);
  const replay = World.fromReplay(world.replay());
  assert.deepEqual(replay.snapshot(), world.snapshot());
});

test("a fresh radio route cannot guide a patrol after visual contact is lost", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  start(world);
  const { pursuit: run } = world;
  for (let i = 0; i < 125; i++) world.step();
  const unit = [...run.patrols].find(patrol => patrol.aiState === "RADIO_SUPPORT");
  assert.ok(unit, "the fresh report must first drive a real radio assignment");
  const report = run.response.lastSeen;
  const relayPath = unit.path;
  run.response.unitsInContact = 0;
  run.response.sightedBy.clear();
  const blinded = new Proxy(world, { get(target, prop, receiver) {
    if (prop === "player") throw new Error("hidden current player pose");
    return Reflect.get(target, prop, receiver);
  } });
  const choose = gtaPatrolCommand(blinded, unit, () => false, () => false, 0);
  assert.notEqual(choose.reason, "RADIO_SUPPORT");
  assert.notEqual(unit.aiState, "RADIO_SUPPORT");
  assert.notEqual(unit.path, relayPath);
  assert.equal(run.response.lastSeen, report);
  world.step();
  assert.equal(run.gta.pressure.relays.size, 0);
  assert.equal(run.gta.pressure.stage, 0);
});

test("a fresh walker or vehicle occupying the first road changes the route, but stale tracks cannot", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  Object.assign(world.player, { x: -205, z: -109.3, heading: Math.PI / 2 });
  start(world, { ...config, maxActivePatrols: 0 });
  const rays = Array.from({ length: PURSUIT_SCAN_RAYS }, () => ({ kind: "none", rangeM: 48 }));
  const baseline = selectSensorEscapeGoal(world, { rays, tracks: [] });
  const occupied = { x: -173.6, z: -109.3 };
  const gap = goal => {
    const path = planDistrictRoute(world.district, world.player, goal);
    return Math.min(...path.map(point => distance(point, occupied)));
  };
  assert.ok(gap(baseline) < .3, "the setup actually places the observation in the old path");
  const audited = new Proxy(world, { get(target, prop, receiver) {
    if (["actors", "actorIndex", "statics"].includes(prop))
      throw new Error(`unobserved input: ${prop}`);
    return Reflect.get(target, prop, receiver);
  } });
  for (const kind of ["pedestrian", "vehicle"]) {
    const track = { kind, rightM: 0, forwardM: 31.4, motionKnown: false };
    const alternate = selectSensorEscapeGoal(audited, { rays, tracks: [{ ...track, ageS: 0 }] });
    assert.ok(gap(alternate) > 5, `${kind}: choose a reachable road around the obstruction`);
    const stale = selectSensorEscapeGoal(audited, { rays, tracks: [{ ...track, ageS: .5 }] });
    assert.deepEqual(stale, baseline, `${kind}: stale returns do not reroute the car`);
  }
});

test("old Max and lower difficulties do not silently acquire a new pressure profile", () => {
  const { cityPackPressure, ...legacy } = config;
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  assert.throws(() => start(world, config, 3), /Level 4 or 5/);
  assert.equal(world.pursuit, null);
  start(world, legacy);
  assert.equal(world.pursuit.gta.pressure, undefined);
  assert.equal(world.snapshot().pursuit.gta.packPressure, undefined);
  const replay = World.fromReplay(world.replay());
  assert.deepEqual(replay.snapshot(), world.snapshot());
});
