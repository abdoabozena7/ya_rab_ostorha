import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const bytes = await readFile(new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const checkpointSha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(checkpointSha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const policy = freezePursuitPolicy(JSON.parse(bytes));
const seed = "city-route-dev-eval-00";
const options = { ruleset: "dispatch-v1", wantedLevelStart: 5, wantedLevelMax: 5,
  maxActivePatrols: 12, episodeMaxSeconds: 120 };
const pose = actor => [actor.x, actor.z, actor.heading, actor.speed, actor.distance, actor.reason, actor.blockedBy ?? null];

function run(preview) {
  const env = new GtaPursuitEnv();
  const initial = env.reset({ seed, traffic: 96, pedestrians: 144, observation: policy.observation, shield: true,
    config: preview ? { ...options, civilianCrossingPreview: true } : options });
  const { world } = env;
  const actors = world.actors.filter(actor => !actor.pursuitRole && actor !== world.player);
  assert.equal(actors.filter(a => a.type === "vehicle").length, 96);
  assert.equal(actors.filter(a => a.type === "pedestrian").length, 144);
  const taxi = actors.find(actor => actor.id === "traffic-37"), person = actors.find(actor => actor.id === "person-80");
  assert.ok(taxi?.kind === "taxi" && person?.type === "pedestrian");
  const trace = [], contacts = [], step = world.step;
  const start = { taxi: pose(taxi), person: pose(person) };
  let firstYield = null, crossing = null, resumed = null, lateralAtStart, laneX, peakActive = 0;
  let obs = initial.obs;
  world.step = function () {
    step.call(this);
    const { tick, pursuit } = world;
    for (const event of pursuit.stepEvents) if (event.type === "ambient_collision") contacts.push(event);
    if (tick === 150) {
      laneX = taxi.x;
      lateralAtStart = Math.sign(person.x - laneX);
    }
    if (tick >= 150) {
      const gap = (person.x - laneX) * lateralAtStart;
      if (gap < -taxi.width / 2 - person.radius) crossing ??= { tick, taxiDistanceM: taxi.distance };
      if (taxi.reason === "pedestrian-yield" && taxi.blockedBy === person.id)
        firstYield ??= { tick, speed: taxi.speed, person: pose(person) };
      if (crossing && taxi.speed > 1 && taxi.distance > crossing.taxiDistanceM + 2)
        resumed ??= { tick, currentMps: taxi.speed, afterCrossingM: taxi.distance - crossing.taxiDistanceM };
    }
    if (tick % 6 === 0) trace.push({ tick, taxi: pose(taxi), person: pose(person) });
  };
  while (world.tick < 480 && world.pursuit.phase === "running") {
    obs = env.step(policy.action(obs)).obs;
    assert.ok(actors.every(actor => world.actors.includes(actor)), "An original City actor was replaced");
    peakActive = Math.max(peakActive, [...world.pursuit.patrols].filter(patrol => patrol.aiState !== "WRECKED").length);
  }
  assert.equal(world.tick, 480);
  assert.ok(peakActive > 0);
  const paired = contacts.filter(event => [event.first.id, event.second.id].includes(taxi.id) &&
    [event.first.id, event.second.id].includes(person.id));
  const pedestrianContacts = contacts.filter(event => event.first.type === "pedestrian" || event.second.type === "pedestrian");
  return { preview, start, ticks: world.tick, peakActive, cars: 96, pedestrians: 144, firstYield, crossing, resumed,
    egoContacts: world.pursuit.metrics.collisions, taxiDistanceM: taxi.distance, personDistanceM: person.distance,
    paired, pedestrianContacts, contacts, trace };
}

const report = { classification: "development, not a held-out score", seed, checkpointSha256, runtime: process.version };
try {
  report.prior = run(false);
  assert.ok(report.prior.paired.some(event => event.tick === 255 && event.closingSpeed > 4));
  if (!process.argv.includes("--prior-only")) {
    report.preview = run(true);
    assert.deepEqual(report.preview.start, report.prior.start);
    assert.equal(report.preview.paired.length, 0, "The same taxi and pedestrian must not collide");
    assert.equal(report.preview.egoContacts, 0);
    assert.ok(report.preview.firstYield?.tick < 220, "The taxi must yield before the previous reaction");
    assert.ok(report.preview.crossing && report.preview.resumed, "The person must cross and the taxi must continue");
  }
} finally {
  await writeFile(join(output, "civilian-crossing.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  for (const { trace, ...row } of [report.prior, report.preview].filter(Boolean))
    console.log(JSON.stringify({ preview: row.preview, firstYield: row.firstYield, crossing: row.crossing,
      resumed: row.resumed, paired: row.paired, pedestrianContacts: row.pedestrianContacts, egoContacts: row.egoContacts }));
}
