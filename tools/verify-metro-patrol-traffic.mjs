import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { run, validation as originalSites } from "./train-metro-lateral-development.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
const mode = process.argv[2];
assert.ok(output && ["observe", "repair"].includes(mode), "Choose a mode and a fresh evidence directory");
const input = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-sustained-pressure-20261121/runs/fit/20261121T041811-efe40aab39/sustained-pressure.json", import.meta.url));
const inputSha256 = createHash("sha256").update(input).digest("hex");
assert.equal(inputSha256, "33fdcb83a4d23f85d16a35a70266dbaac4b894e8af47ade63925b7ade63ea6cf");
const { validation, controls } = JSON.parse(input);
const report = { inputSha256, mode, node: process.version, classification: "fixed local Metro development; no holdout" };
const preview = { patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW };
const go = { steer: 0, throttle: 1, brake: 0, gear: 1 };

function recorder() {
  const frames = [];
  return { frames, sample(world, tail, sedan) {
    if (!tail || !sedan) return;
    const dx = sedan.x - tail.x, dz = sedan.z - tail.z;
    const sin = Math.sin(tail.heading), cos = Math.cos(tail.heading);
    frames.push({ tick: world.tick, sedanSpeed: sedan.speed, tailSpeed: tail.speed, steer: tail.steer, heading: tail.heading,
      egoSpeed: world.player.speed, tailDistance: tail.distance, forward: dx * sin + dz * cos, side: dx * cos - dz * sin,
      ai: tail.aiState, reason: tail.reason, blocker: tail.blockedBy, egoSighted: world.pursuit.response.sightedBy.has(tail) });
  } };
}

function rerun(site, expected, until = expected.tick, options = {}) {
  const obs = recorder();
  let next = 2;
  const result = run(site, "combined", () => expected.trace[next++].request, expected.plan, until, false,
    { ...options, observeTick: obs.sample });
  return { ...result, frames: obs.frames };
}

const contacts = summary => summary.incidents.filter(event => event.type !== "near_miss");

function testPair(site, { first, last }) {
  const short = rerun(site, first, 228, preview), long = rerun(site, last, 264, preview);
  assert.deepEqual(short.summary.handoff, first.handoff);
  assert.deepEqual(long.summary.handoff, last.handoff);
  assert.deepEqual(long.frames.slice(0, 228), short.frames);
  const score = ({ summary, frames }, horizon) => ({
    pass: summary.tick === horizon && summary.noContact && summary.onRoad && summary.clearanceOK &&
      (horizon !== 228 || summary.pass) && frames.every(row => row.sedanSpeed === 0) &&
      summary.roadBoundaryTicks === 0 && summary.firstClearTick > 0 && summary.firstClearTick <= 192 &&
      summary.postClearAdvanceM > 2 && summary.postClearNonforwardTicks === 0 &&
      summary.handoff.rear.forwardMps > 1.5 && summary.patrolM - summary.handoff.tailDistance > 8 &&
      frames.at(-1).tailSpeed > 3 && frames.some(row => row.reason === "traffic-yield"),
    summary, frames,
  });
  return { site, short: score(short, 228), long: score(long, 264) };
}

function releaseCourse(option, mode = "loading") {
  const world = new World({ cityVersion: 4, seed: "metro-patrol-traffic-release", traffic: 0, pedestrians: 0 }, "metro");
  const road = world.drivingRoads.find(road => road.id === "university-avenue");
  const cross = world.drivingRoads.find(road => road.id === "civic-avenue");
  const config = { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
    enablePitManeuver: false, enableRamming: false, enableRoadblocks: false, maxActivePatrols: 1,
    surveillanceZones: [{ id: "release-university", minX: -278, maxX: -85, minZ: 80, maxZ: 98 }],
    ...option };
  const { player } = world;
  Object.assign(player, districtRoadPose(road, -153, 1), { speed: 12 });
  world.command({ type: "street-pursuit-start", variant: "gta", config }, false);
  const [tail] = world.pursuit.patrols;
  const departing = mode === "departing";
  const sedan = world.makeVehicle("release-sedan", "sedan",
    departing ? districtRoadPose(cross, 85.5, -1) : districtRoadPose(road, -209, 1));
  Object.assign(tail, districtRoadPose(road, -233, 1), { speed: 13 });
  sedan.path = planDistrictRoute(world.district, sedan,
    { roadId: cross.id, ...districtRoadPose(cross, 57, -1) });
  assert.ok(sedan.path.length > 10);
  const loading = mode === "loading" || mode === "extended-loading";
  const loadUntil = mode === "extended-loading" ? 285 : 155;
  sedan.speed = loading ? 0 : 7;
  initializeDistrictActor(world, sedan);
  Object.assign(sedan.district, { loadingUntilTick: loading ? loadUntil : null, nextLoadingDistanceM: null,
    loadingOnce: true, profile: "ordinary" });
  world.actors.push(sedan);
  assert.ok([tail, sedan, player].every((car, i, all) => bodyOnRoad(car, world.roads) &&
    all.slice(0, i).every(other => !overlaps(car, other, .12))));
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  world.command({ type: "pursuit-drive", action: PURSUIT_STOP }, false);
  let firstYield = null, stopped = null, resumed = null;
  const incidents = [], speeds = [];
  const endTick = mode === "extended-loading" ? 420 : 280;
  for (let i = 0; i < endTick && world.pursuit.phase === "running"; i++) {
    const before = tail.speed;
    world.step();
    assert.ok(world.actors.includes(sedan) && world.actors.includes(tail));
    if (tail.reason === "traffic-yield" && tail.blockedBy === sedan.id && tail.speed < before)
      firstYield ??= { tick: world.tick, speed: tail.speed, distance: tail.distance };
    if (firstYield && !stopped && tail.speed === 0)
      stopped = { tick: world.tick, distance: tail.distance, separation: distance(tail, sedan) };
    if (stopped && !resumed && tail.speed > .7 && tail.distance - stopped.distance > 2 && sedan.distance > 2)
      resumed = { tick: world.tick, patrolM: tail.distance - stopped.distance, sedanM: sedan.distance };
    incidents.push(...world.pursuit.stepEvents.filter(event =>
      ["ambient_collision", "patrol_collision", "static_or_civilian_hit"].includes(event.type)));
    speeds.push([world.tick, tail.speed, tail.reason, sedan.speed, distance(tail, sedan)]);
  }
  return { firstYield, stopped, resumed, incidents, speeds, ticks: world.tick, tailM: tail.distance, sedanM: sedan.distance };
}

function replayControl(option) {
  const world = new World({ cityVersion: 4, seed: "metro-patrol-version-replay", traffic: 4, pedestrians: 2 }, "metro");
  world.command({ type: "street-pursuit-start", variant: "gta", config: { ruleset: "dispatch-v1", ...option } });
  world.command({ type: "pursuit-drive", action: go });
  for (let i = 0; i < 120; i++) world.step();
  const data = JSON.parse(JSON.stringify(world.replay()));
  assert.equal(data.events[0].command.config.patrolTrafficPreview, option?.patrolTrafficPreview);
  assert.deepEqual(World.fromReplay(data).snapshot(), world.snapshot());
  return { profile: option?.patrolTrafficPreview ?? null, ticks: world.tick };
}

try {
  report.cases = validation.map(({ site, candidate }, i) => {
    const old = rerun(site, candidate.last), good = rerun(site, controls[i].long);
    assert.deepEqual(old.summary, candidate.last);
    assert.deepEqual(good.summary, controls[i].long);
    assert.equal(old.summary.handoff.obsSha256, good.summary.handoff.obsSha256);
    assert.ok(old.frames.length === 264 && good.frames.length === 264 && good.summary.noContact);
    const [hit] = contacts(old.summary);
    assert.equal(contacts(old.summary).length, 1);
    assert.ok(hit.type === "ambient_collision" && hit.first.patrol && hit.second.kind === "sedan" && hit.closingSpeed > 10);
    return { site, hit, baseline: old.frames, reference: good.frames, sameTraces: 2 };
  });
  report.matchingArms = report.cases.reduce((sum, row) => sum + row.sameTraces, 0);
  report.baselineContacts = report.cases.length;
  for (const { site, hit, baseline, reference } of report.cases) {
    const approaching = baseline.filter(row => row.tick >= hit.tick - 36 && row.tick < hit.tick && row.tick % 6 === 0);
    const nearby = reference.filter(row => row.tick >= hit.tick - 36 && row.tick < hit.tick && row.tick % 6 === 0);
    console.log(JSON.stringify({ site, hit, approaching, reference: nearby }));
  }
  if (mode === "repair") {
    report.repaired = validation.map(({ site, candidate }) => testPair(site, candidate));
    report.shortPasses = report.repaired.filter(row => row.short.pass).length;
    report.longPasses = report.repaired.filter(row => row.long.pass).length;
    report.clearControls = [...originalSites.map(site => [site, "rear-only"]),
      ...validation.map(({ site }) => [site, "no-tail"])].map(([site, kind]) => {
      const a = run(site, kind, () => go, null, 228, true);
      const b = run(site, kind, () => go, null, 228, true, preview);
      assert.deepEqual(a.summary, b.summary);
      assert.deepEqual(a.motionAudit, b.motionAudit);
      assert.deepEqual(a.samples, b.samples);
      return { site, kind, exact: true, patrolM: b.summary.patrolM };
    });
    report.clearArmsExact = report.clearControls.every(row => row.exact);
    const earlyRelease = releaseCourse(preview), stopped = releaseCourse(preview, "extended-loading");
    const old = releaseCourse(), moving = releaseCourse(preview, "following"), movingBefore = releaseCourse(undefined, "following");
    const departing = releaseCourse(preview, "departing"), departingBefore = releaseCourse(undefined, "departing");
    assert.deepEqual(departing, departingBefore);
    report.release = { earlyRelease, stopped, old, moving, movingBefore, departing };
    report.releasePassed = stopped.stopped?.separation > 4 && stopped.incidents.length === 0 && Boolean(stopped.resumed) &&
      earlyRelease.firstYield !== null && earlyRelease.incidents.length === 0 && earlyRelease.sedanM > 2 &&
      old.incidents.some(event => event.type === "ambient_collision" && event.second.id === "release-sedan") &&
      moving.incidents.length === 0 && moving.tailM > 10 &&
      movingBefore.incidents.some(event => event.type === "ambient_collision" && event.second.id === "release-sedan") &&
      departing.firstYield === null && departing.incidents.length === 0 && departing.sedanM > 10 && departing.tailM > 10;
    const launch = { ruleset: "legacy", ...preview };
    const world = new World({ cityVersion: 4, traffic: 0, pedestrians: 0 }, "metro");
    assert.throws(() => world.command({ type: "street-pursuit-start", variant: "gta", config: launch }),
      /patrolTrafficPreview/);
    assert.throws(() => world.command({ type: "street-pursuit-start", variant: "gta",
      config: { ruleset: "dispatch-v1", patrolTrafficPreview: true } }), /patrolTrafficPreview/);
    report.replays = [replayControl(), replayControl(preview)];
    report.replayExact = true;
    assert.ok(report.shortPasses === 4 && report.longPasses === 4 && report.clearArmsExact && report.releasePassed,
      "One or more physical patrol traffic controls failed");
  }
} finally {
  await writeFile(join(output, "patrol-traffic.json"), JSON.stringify(report), { flag: "wx" });
}
