import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { World } from "../src/core/world.js";
import { bodyOnRoad, angleDelta, distance, corners, roadRect } from "../src/core/geometry.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR for finite district evaluation");
await mkdir(output, { recursive: true });
const development = process.argv.includes("--development");
const report = { passed: false, developmentOnly: development, completedChainedTrips: 0, violations: [], runs: [] };
const motion = (actor) => ({
  id: actor.id, x: actor.x, z: actor.z, heading: actor.heading, speedMps: actor.speed,
  acceptedDistanceM: actor.distance, reason: actor.reason, blockedBy: actor.blockedBy ?? null,
  radiusM: actor.radius, widthM: actor.width, lengthM: actor.length,
  appliedSource: actor.districtSources?.appliedSource,
  targetSpeedMps: actor.districtSources?.finalMps,
});
try {
  for (const seed of development ? ["district-dev-a"] : ["district-cairo-a", "district-cairo-b", "district-cairo-c"]) {
    const world = new World({ seed }, "egypt");
    const ids = world.actors.map((actor) => actor.id).sort();
    assert.equal(world.capacity.traffic, 28);
    assert.equal(world.capacity.pedestrians, 32);
    world.command({ type: "visual-mode", mode: "sensors-only" });
    const run = { seed, evidenceClass: "actual offline World physics; no live camera inference claimed",
      capacity: world.capacity, trips: [], samples: [], narrowContinuousM: {}, alleyMotion: [] };
    report.runs.push(run);
    const narrowRoads = world.district.drivingRoads.filter((road) => road.width <= 4);
    const causes = new Map();
    for (const place of world.district.places) {
      const before = world.metrics.completedTrips;
      assert.equal(world.command({ type: "destination", place }), true);
      const startTick = world.tick;
      const narrowRun = {};
      while (world.tick - startTick < 180 * 60 && world.metrics.completedTrips === before) {
        const previous = world.actors.map((actor) => ({ id: actor.id, x: actor.x, z: actor.z,
          speed: actor.speed, maxSpeed: actor.maxSpeed ?? actor.body.jogSpeedMps, motion: motion(actor) }));
        world.step();
        const errors = world.audit();
        if (errors.length) {
          report.violations.push({ seed, tick: world.tick, errors });
          throw new Error(`Physical audit failed at ${seed}/${world.tick}: ${errors.join(",")}`);
        }
        assert.deepEqual(world.actors.map((actor) => actor.id).sort(), ids, "Progress cannot recycle actors");
        world.actors.forEach((actor, index) => {
          assert.ok(distance(actor, previous[index]) <= Math.max(previous[index].maxSpeed, 4) / 60 + .02,
            `${actor.id} made an unphysical pose jump`);
          if (actor.type === "vehicle")
            assert.ok(bodyOnRoad(actor, world.roads, .12),
              `${actor.id} lost the required whole-body0.12m road clearance at tick${world.tick}`);
        });
        const playerCorners = corners(world.player);
        const delta = distance(world.player, previous[0]);
        for (const road of world.district.drivingRoads.filter((item) => item.width <= 4)) {
          const rect = roadRect(road, .12);
          const entirelyNarrow = playerCorners.every((point) => point.x >= rect.minX && point.x <= rect.maxX
            && point.z >= rect.minZ && point.z <= rect.maxZ)
            && !world.roads.filter((item) => item.supportApron).some((apron) => {
              const box = roadRect(apron);
              return playerCorners.some((point) => point.x >= box.minX && point.x <= box.maxX
                && point.z >= box.minZ && point.z <= box.maxZ);
            });
          narrowRun[road.id] = entirelyNarrow ? (narrowRun[road.id] ?? 0) + delta : 0;
          run.narrowContinuousM[road.id] = Math.max(run.narrowContinuousM[road.id] ?? 0, narrowRun[road.id]);
        }
        if (world.tick % 60 === 0)
          run.samples.push({ tick: world.tick, player: { x: world.player.x, z: world.player.z,
            speed: world.player.speed, reason: world.player.reason },
          trafficTrips: world.metrics.trafficTrips, blockingCycles: world.metrics.trafficBlockingCycles,
          behaviorBlockingCycles: world.districtBehavior.metrics.blockingCycles,
          peakBehaviorBlockingCycles: world.districtBehavior.metrics.peakBlockingCycles });
        if (world.districtBehavior.metrics.blockingCycles
            || world.districtBehavior.metrics.peakBlockingCycles)
          run.failedWorld = world.snapshot();
        assert.equal(world.districtBehavior.metrics.blockingCycles, 0,
          `${seed}: district resource blocking cycle at tick${world.tick}`);
        assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0,
          `${seed}: district resource blocking cycle occurred before tick${world.tick}`);
        const narrowCars = world.actors.flatMap((actor, index) => {
          if (actor.type !== "vehicle") return [];
          const road = narrowRoads.find((road) => {
            const across = road.axis === "z" ? actor.x : actor.z;
            const along = road.axis === "z" ? actor.z : actor.x;
            return Math.abs(across - road.fixed) <= road.width / 2 && along >= road.min && along <= road.max;
          });
          return road ? [{ actor, index, road }] : [];
        });
        let changedCause = false;
        for (const { actor } of narrowCars) {
          const cause = `${actor.reason}:${actor.blockedBy}`;
          if (causes.get(actor.id) !== cause) changedCause = true;
          causes.set(actor.id, cause);
        }
        if (narrowCars.length && (changedCause || world.tick % 6 === 0))
          run.alleyMotion.push({
            tick: world.tick,
            vehicles: narrowCars.map(({ actor, index, road }) => ({
              ...motion(actor), before: previous[index].motion, roadId: road.id,
              wholeBodyInsideNarrow012: bodyOnRoad(actor, [road], .12),
            })),
            people: world.actors.filter((actor) => actor.type === "pedestrian"
              && narrowCars.some(({ actor: car }) => distance(actor, car) <= 10)).map(motion),
          });
      }
      const player = world.player;
      if (world.metrics.completedTrips === before)
        run.failedWorld = world.snapshot();
      const trip = { destination: place.id, ticks: world.tick - startTick,
        distanceM: distance(player, place), headingErrorRad: Math.abs(angleDelta(player.heading, place.heading)),
        speedMps: player.speed, wholeBodyOnRoad: bodyOnRoad(player, world.roads),
        completedIncrement: world.metrics.completedTrips - before };
      run.trips.push(trip);
      assert.equal(trip.completedIncrement, 1, JSON.stringify(trip));
      assert.ok(trip.distanceM <= .8 && trip.headingErrorRad <= .2
        && Math.abs(trip.speedMps) <= .05 && trip.wholeBodyOnRoad, JSON.stringify(trip));
      report.completedChainedTrips++;
    }
    for (const road of world.district.drivingRoads.filter((item) => item.width <= 4))
      assert.ok(run.narrowContinuousM[road.id] >= 12,
        `${seed}: the actual route chain must drive at least12m wholly inside ${road.id}, not just touch its mouth`);
    assert.equal(world.metrics.trafficBlockingCycles, 0);
  }
  report.passed = true;
  console.log(JSON.stringify({ passed: true, completedChainedTrips: report.completedChainedTrips, violations: [] }));
} finally {
  await writeFile(path.join(output, development ? "district-core-development.json" : "district-core.json"),
    JSON.stringify(report, null, 2));
}
