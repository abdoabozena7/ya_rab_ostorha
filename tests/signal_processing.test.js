import test from "node:test";
import assert from "node:assert/strict";
import {
  measureRanges,
  RangeSignalProcessor,
  SENSOR_MAX_M,
} from "../src/signal_processing/range-sensors.js";

test("the forward range beam measures the visible box face in metres", () => {
  const car = {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    length: 4,
    width: 1.8,
  };
  const obstacle = {
    id: "van",
    type: "vehicle",
    x: 0,
    z: 10,
    heading: 0,
    length: 4,
    width: 2,
  };
  const ranges = measureRanges({ actors: [car, obstacle], statics: [] }, car);
  assert.equal(ranges[2], 5.85);
  assert.equal(ranges[0], SENSOR_MAX_M);
  assert.equal(ranges[4], SENSOR_MAX_M);
});

test("range processing retains raw measurements and smooths transient samples", () => {
  const processor = new RangeSignalProcessor();
  processor.update([35, 35, 35, 35, 35]);
  const transient = processor.update([35, 35, 5, 35, 35]);
  assert.equal(transient.rawM[2], 5);
  assert.equal(transient.filteredM[2], 35);
  const confirmed = processor.update([35, 35, 5, 35, 35]);
  assert.equal(confirmed.filteredM[2], 21.5);
  assert.equal(confirmed.source, "simulated-geometry");
});
