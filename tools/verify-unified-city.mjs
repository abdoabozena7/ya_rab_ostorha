import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { distance } from "../src/core/geometry.js";
import { onRoadLimit } from "../src/core/district-behavior.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";

const output = process.env.PROVE_IT_OUTPUT_DIR ?? "output/unified-city";
const seed = process.env.METRO_DEVELOPMENT_SEED ?? "cairo-42";
if (process.env.PROVE_IT_RUN_ID && process.env.METRO_DEVELOPMENT_SEED)
  throw new Error("The sealed City check uses the public default seed");
const newCity = () => new World({ seed }, "metro");
const totalDistance = path => path.reduce((total, point, index) =>
  total + (index ? distance(point, path[index - 1]) : 0), 0);

if (process.argv.includes("--negative")) {
  const city = newCity();
  const goal = city.district.showcaseRoutes[0].goal;
  assert.ok(city.command({ type: "destination", place: goal }, false));
  city.district = { ...city.district, drivingRoads: city.district.drivingRoads.filter(road => road.zone !== "avenue") };
  assert.equal(city.command({ type: "destination", place: goal }, false), false);
  assert.throws(() => city.command({ type: "street-pursuit-start", level: 0 }), /level|difficulty/i);
  assert.equal(city.pursuit, null);
  assert.throws(() => city.command({ type: "pursuit-drive", action: { ...PURSUIT_STOP, steer: 2 } }));
  console.log("EXPECTED_UNIFIED_CITY_FAILURE_DETECTED");
  process.exitCode = 3;
} else {
  const report = { passed: false, seed, samples: [] };
  try {
    const city = newCity(), layout = city.district;
    assert.deepEqual(city.capacity, { traffic: 28, pedestrians: 32 });
    const goal = layout.showcaseRoutes[0].goal;
    const extent = city.drivingRoads.map(road => road.axis === "x" ? [road.min, road.max] : [road.fixed, road.fixed]);
    assert.ok(Math.max(...extent.map(span => span[1])) - Math.min(...extent.map(span => span[0])) >= 320);
    for (const id of ["downtown", "market", "station", "hospital", "university", "corniche",
      "district-bakery", "district-school", "district-workshop"])
      assert.ok(layout.places.some(place => place.id === id), id);
    assert.ok(city.command({ type: "destination", place: goal }), "Public journey has a physical route");
    const distances = new Map(), speeds = new Map();
    let beforeChase;
    const planM = totalDistance(city.player.path);
    while (city.metrics.completedTrips === 0 && city.tick < 60 * 190) {
      const { x, z } = city.player;
      city.step();
      const road = onRoadLimit(city, city.player);
      if (road.roadId) {
        distances.set(road.roadId, (distances.get(road.roadId) ?? 0) + distance({ x, z }, city.player));
        speeds.set(road.roadId, Math.max(speeds.get(road.roadId) ?? 0, Math.abs(city.player.speed)));
      }
      if (!beforeChase && city.metrics.distance >= 18 && road.width >= 10)
        beforeChase = city.replay();
      if (city.tick % 600 === 0) {
        assert.deepEqual(city.audit(), []);
        report.samples.push({ tick: city.tick, x: city.player.x, z: city.player.z,
          speed: city.player.speed, reason: city.player.reason,
          blockedBy: city.player.blockedBy, road: road.roadId, distanceM: city.metrics.distance });
      }
    }
    report.journey = { goal, planM, actualM: city.metrics.distance, ticks: city.tick,
      completed: city.metrics.completedTrips, reason: city.player.reason, blockedBy: city.player.blockedBy,
      stoppedAt: { x: city.player.x, z: city.player.z, heading: city.player.heading },
      streets: [...distances].map(([id, metres]) => ({ id, metres, peakMps: speeds.get(id) })) };
    assert.equal(city.metrics.completedTrips, 1, JSON.stringify(report.journey));
    assert.ok(distance(city.player, goal) < .8);
    assert.ok(city.metrics.distance >= 140 && beforeChase);
    assert.ok(city.drivingRoads.some(road => road.width >= 10 && road.zone === "avenue" &&
      (distances.get(road.id) ?? 0) >= 20 && speeds.get(road.id) >= 5));
    assert.ok(city.drivingRoads.some(road => road.width <= 3.8 &&
      (distances.get(road.id) ?? 0) >= 12 && speeds.get(road.id) <= 4.2));
    const movingPeople = city.actors.filter(actor => actor.type === "pedestrian" && actor.distance > 3);
    report.people = { moved: movingPeople.length, behavior: city.districtBehavior.metrics,
      events: [...new Set(city.districtBehavior.events.map(event => event.kind))] };
    assert.ok(movingPeople.length >= 10 && report.people.behavior.pedestrianDecisions > 0);

    const chase = World.fromReplay(beforeChase);
    const { actors, roads, player, statics } = chase;
    const originals = [...actors], initial = { tick: chase.tick, ...chase.snapshot().actors[0] };
    const previousDestination = chase.destination;
    chase.command({ type: "street-pursuit-start", level: 2 });
    assert.equal(chase.roads, roads);
    assert.equal(chase.player, player);
    assert.equal(chase.statics, statics);
    assert.equal(chase.tick, initial.tick);
    assert.equal(distance(player, initial), 0);
    assert.ok(originals.every(actor => chase.actors.includes(actor)));
    const patrols = chase.actors.filter(actor => actor.pursuitRole === "police");
    assert.ok(patrols.length > 1);
    const through = chase.tick + 720;
    const beforeCrowd = new Map(originals.map(actor => [actor, actor.distance]));
    while (chase.pursuit.phase === "running" && chase.tick < through) {
      chase.step();
      if (chase.tick % 60 === 0) assert.deepEqual(chase.audit(), []);
    }
    const inPursuit = { tick: chase.tick, phase: chase.pursuit.phase,
      decision: chase.pursuit.decision?.name, source: chase.pursuit.decision?.source,
      distanceM: chase.pursuit.metrics.distanceM, policeUnlockedM: patrols.map(actor => actor.distance),
      movingCivilians: originals.filter(actor => actor !== player && actor.type === "vehicle" &&
        actor.distance - beforeCrowd.get(actor) > 2).length,
      movingPeople: originals.filter(actor => actor.type === "pedestrian" &&
        actor.distance - beforeCrowd.get(actor) > 2).length,
      events: chase.pursuit.events.map(event => event.kind), contact: chase.pursuit.metrics.impact,
    };
    report.pursuit = inPursuit;
    assert.ok(inPursuit.policeUnlockedM.some(metres => metres > 3) && inPursuit.distanceM >= 4);
    assert.ok(inPursuit.movingCivilians > 0 && inPursuit.movingPeople > 0);
    assert.ok(inPursuit.decision && inPursuit.events.some(kind =>
      ["closure", "roadblock", "congestion", "impact"].includes(kind)));
    if (chase.pursuit.phase === "running") chase.command({ type: "street-pursuit-stop" });
    assert.ok(originals.every(actor => chase.actors.includes(actor)));
    assert.ok(chase.actors.every(actor => actor.pursuitRole !== "police"));
    assert.equal(chase.destination, previousDestination);
    assert.ok(chase.player.path.length > 2, "Resume the same trip at the actual pursuit end pose");
    const ended = { tick: chase.tick, distanceM: chase.metrics.distance, phase: chase.pursuit.phase };
    for (let i = 0; i < 180; i++) chase.step();
    assert.ok(chase.tick > ended.tick && chase.metrics.distance > ended.distanceM + 1);
    const replay = World.fromReplay(chase.replay());
    assert.deepEqual(replay.snapshot(), chase.snapshot());
    assert.deepEqual(chase.audit(), []);
    report.resume = { ...ended, distanceAfterM: chase.metrics.distance - ended.distanceM, exactReplay: true };
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    throw error;
  } finally {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "unified-engine.json"), JSON.stringify(report, null, 2));
  }
}
