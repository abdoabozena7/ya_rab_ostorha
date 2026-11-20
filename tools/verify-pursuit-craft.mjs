import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyOnRoad, distance } from "../src/core/geometry.js";
import { pursuitSnapshot } from "../src/core/pursuit-world.js";
import { World } from "../src/core/world.js";

const old = process.argv.includes("--old");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const world = new World({ seed: "cairo-42", cityVersion: 4, traffic: 96, pedestrians: 144,
  speedLimit: 50 }, "metro");
const ordinary = [...world.actors], permanent = world.statics;
const report = { passed: false };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const start = { type: "street-pursuit-start", level: 4, variant: old ? "rush" : "cinematic" };
const read = () => {
  const { player, tick, pursuit } = world, { response } = pursuitSnapshot(world);
  return { tick, x: player.x, z: player.z, speedMps: player.speed, distanceM: pursuit.metrics.distanceM,
    phase: pursuit.phase, response, patrols: [...pursuit.patrols].map(car => ({
      id: car.id, movedM: car.distance, gapM: distance(player, car), x: car.x, z: car.z,
    })) };
};
try {
  world.command(start);
  const timeline = report.timeline = [read()];
  for (let i = 1; i <= 360; i++) {
    world.step();
    assert.ok(bodyOnRoad(world.player, world.roads), "The chase cannot drive through an unsupported corner");
    if (i % 15 === 0) timeline.push(read());
  }
  const current = digest(world.snapshot());
  report.stateDigest = current;
  assert.deepEqual(world.audit(), []);
  if (old) {
    assert.equal(current, "ae95192b68f2970ef100319fe5711e943961c738f3e723000e5c1e7d49f2e444");
    assert.ok(timeline.every(frame => frame.response === undefined),
      "The old run must lack physical visibility transitions");
    console.log("EXPECTED_RUSH_WITHOUT_SEARCH");
    process.exitCode = 3;
  } else {
    const active = timeline.filter(frame => frame.response?.stage === "contact" &&
      frame.response.unitsInContact > 0);
    assert.ok(active.length >= 5 && active.some(frame => frame.speedMps >= 10.5),
      "Real patrol sight should persist with an actually moving target");
    assert.ok(timeline.at(-1).distanceM >= 30 && timeline.at(-1).phase === "running");
    assert.ok(timeline.at(-1).patrols.filter(car => car.movedM >= 8).length >= 3);
    assert.ok(world.pursuit.events.some(event => event.kind === "reinforcement"));
    assert.ok(ordinary.every(car => world.actors.includes(car)));
    assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
    assert.equal(current, digest(World.fromReplay(world.replay()).snapshot()));
    world.command({ type: "street-pursuit-stop" });
    assert.equal(world.mode, "manual");
    assert.deepEqual(world.actors, ordinary);
    assert.equal(world.statics, permanent);
    const controlled = execFileSync(process.execPath, ["--test",
      fileURLToPath(new URL("../tests/embedded-pursuit-world.test.js", import.meta.url))],
    { encoding: "utf8", timeout: 45_000 });
    assert.match(controlled, /^ok \d+ - cinematic sees a .* searches a frozen report, reacquires and cools anew$/m);
    assert.match(controlled, /^ok \d+ - hidden waiting at launch cannot clear/m);
    report.controlledStreet = controlled;
    report.passed = true;
    console.log("REAL_CITY_CONTACT_DISPATCH_AND_REPLAY_VERIFIED");
  }
} finally {
  if (output) await writeFile(join(output, "pursuit-craft-engine.json"), JSON.stringify(report, null, 2));
}
