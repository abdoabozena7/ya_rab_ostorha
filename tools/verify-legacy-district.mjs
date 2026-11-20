import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { World } from "../src/core/world.js";
import { integrateVehicle } from "../src/core/vehicle.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshots = {};
for (const seed of ["cairo-42", "district-legacy"]) {
  const world = new World({ seed });
  snapshots[`${seed}:0`] = hash(world.snapshot());
  for (let i = 0; i < 3600; i++) {
    world.step();
    if ([600, 3600].includes(world.tick)) snapshots[`${seed}:${world.tick}`] = hash(world.snapshot());
  }
}
const lab = new World({ traffic: 8, pedestrians: 8 }, "lab");
lab.command({ type: "drive", targetSpeed: 3, steer: 0 });
for (let i = 0; i < 600; i++) lab.step();
snapshots.lab = hash(lab.snapshot());
snapshots.labReplay = hash(World.fromReplay(lab.replay()).snapshot());
let car = { id: "golden", type: "vehicle", x: 0, z: 0, heading: 0, speed: 0, steer: 0,
  length: 4.2, width: 1.85, maxSpeed: 8 };
const trace = [];
for (let i = 0; i < 600; i++) {
  car = integrateVehicle(car, { targetSpeed: i < 300 ? 5 : 0, steer: i < 150 ? 0 : .3 }, 1 / 60);
  trace.push(car);
}
snapshots.vehicle = hash(trace);
const expected = JSON.parse(await readFile(new URL("../tests/fixtures/district-legacy-golden.json", import.meta.url), "utf8"));
const wrong = Object.keys(expected).filter((key) => expected[key] !== snapshots[key]);
if (wrong.length) throw new Error(`Legacy behavior changed: ${wrong.join(",")}`);
console.log("LEGACY_GOLDEN_PRESERVED", Object.keys(snapshots).length);
