import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { gtaLocal } from "../src/core/pursuit-gta.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { isDispatchIncident } from "../src/rl/pursuit-rollouts.js";

const seed = "city-route-dev-eval-00";
const horizonTicks = 840;
const throttle = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const stop = { ...throttle, throttle: 0, brake: 1 };
const sector = (forward, right) => Math.abs(forward) >= Math.abs(right)
  ? forward < 0 ? "rear" : "front" : right < 0 ? "left" : "right";
const radial = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = body => ({ x: body.x, z: body.z, heading: body.heading });

function attempt(level) {
  const env = new GtaPursuitEnv();
  const reset = env.reset({ seed, traffic: 36, pedestrians: 80, config: { ruleset: "dispatch-v1",
    wantedLevelStart: level, wantedLevelMax: level, episodeMaxSeconds: horizonTicks * STEP } });
  const { world } = env, { player, pursuit } = world;
  const originals = world.actors.filter(body => body !== player && !pursuit.patrols.has(body));
  assert.equal(originals.filter(body => body.type === "vehicle").length, 36);
  assert.equal(originals.filter(body => body.type === "pedestrian").length, 80);
  const start = { ...point(player), speed: player.speed };
  const roles = {}, routeByUnit = new Map(), trace = [], incidents = [];
  let qualifiedAt = null, peakActive = 0, pressureRun = 0, longestPressure = 0, sample, observationPressure;
  while (world.tick < horizonTicks && pursuit.phase === "running") {
    const egoWas = point(player);
    const old = new Map([...pursuit.patrols].map(unit => [unit, point(unit)]));
    const held = world.tick >= 476;
    const result = env.step(held ? stop : throttle, 1);
    const present = new Set(world.actors);
    assert.ok(originals.every(body => present.has(body)), "ambient actors must stay in the physical World");
    assert.ok(result.obs.every(Number.isFinite));
    const active = [...pursuit.patrols].filter(unit => unit.aiState !== "WRECKED");
    peakActive = Math.max(peakActive, active.length);
    if (pursuit.response.dispatch.escapeEligible) qualifiedAt ??= world.tick;
    const closing = [];
    for (const unit of active) {
      const prior = old.get(unit);
      if (!prior) continue;
      const slot = roles[unit.squadRole] ??= { ticks: 0, movedM: 0, closingM: 0 };
      const moved = radial(prior, unit), gap = radial(egoWas, unit);
      const gain = radial(egoWas, prior) - gap;
      slot.ticks++;
      slot.movedM += moved;
      if (gain > 0 && gap < 40) slot.closingM += gain;
      // A squad label or a planned route is not proof that the route advanced.
      if (["FLANK", "BLOCK_INTERCEPT"].includes(unit.reason) && moved > 0) {
        const key = `${unit.id}:${unit.reason}`;
        const route = routeByUnit.get(key) ?? { id: unit.id, command: unit.reason, firstTick: world.tick, movedM: 0 };
        route.movedM += moved;
        route.lastTick = world.tick;
        routeByUnit.set(key, route);
      }
      if (gap >= 40 || gain < .75 * STEP || unit.speed < 3 || !present.has(unit)) continue;
      const { right, forward } = gtaLocal(egoWas, unit);
      closing.push({ id: unit.id, role: unit.squadRole, sector: sector(forward, right), gap, gain, speed: unit.speed,
        x: unit.x, z: unit.z });
    }
    if (new Set(closing.map(unit => unit.sector)).size >= 2 && new Set(closing.map(unit => unit.role)).size >= 2) {
      if (++pressureRun > longestPressure) {
        longestPressure = pressureRun;
        sample = { tick: world.tick, firstTick: world.tick - pressureRun + 1, units: closing };
      }
    } else pressureRun = 0;
    if (world.tick % 6 === 0) {
      const scans = pursuit.gta.scan.tracks.filter(track => track.kind === "police" && track.ageS === 0)
        .map(({ forwardM, rightM, motionKnown, ttcS }) => ({
          sector: sector(forwardM, rightM), forwardM, rightM, motionKnown, ttcS,
        }));
      if (new Set(scans.map(scan => scan.sector)).size >= 2)
        observationPressure ??= { tick: world.tick, scans };
      trace.push({ tick: world.tick, pose: point(player), speed: player.speed, closing, scans,
        active: active.length, requested: result.info.requestedAction, applied: result.info.appliedCommand,
        tracking: pursuit.response.dispatch.state });
    }
    incidents.push(...result.info.events.filter(isDispatchIncident));
  }
  return { level, start, resetCapacity: world.capacity, observationLength: reset.obs.length,
    phase: pursuit.phase, ticks: world.tick, qualifiedAt, peakActive, roles, longestPressure, sample,
    observationPressure, routes: [...routeByUnit.values()], trace, incidents, distance: pursuit.metrics.distanceM,
    contacts: pursuit.metrics.collisions, ambientContacts: pursuit.metrics.trafficCollisions,
    pedestrianContacts: pursuit.metrics.pedestrianCollisions };
}

const high = attempt(5), low = attempt(1);
const report = { seed, horizonTicks, purpose: "Scripted five-star physical pressure and low-level control. Not a learned or safety verdict.",
  high, low };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "level-five.json"), JSON.stringify(report), { flag: "wx" });

assert.deepEqual(high.start, low.start);
assert.deepEqual(high.resetCapacity, low.resetCapacity);
assert.equal(high.observationLength, low.observationLength);
assert.ok([high, low].every(run => run.ticks === horizonTicks && run.phase === "timeout"));
assert.ok(high.qualifiedAt && high.peakActive >= 8 && low.peakActive <= 3);
assert.ok(high.longestPressure >= 6, "different roles must physically close from multiple sectors, not just spawn there");
assert.ok(high.observationPressure, "the shared scanner must actually see multiple directions");
assert.ok(high.routes.some(route => route.movedM >= 5), "a tactical unit must physically travel under a real junction command");
assert.ok(low.roles.FLANKER?.movedM > 5 && low.routes.length === 0, "the lower level can assign a label without executing the high-tier tactic");
console.log(JSON.stringify({ high: { peak: high.peakActive, longestPressure: high.longestPressure,
  roles: Object.keys(high.roles), routedMeters: high.routes.map(route => [route.command, route.movedM]),
  contacts: high.contacts, ambientContacts: high.ambientContacts },
low: { peak: low.peakActive, labels: Object.keys(low.roles), routedMeters: 0, contacts: low.contacts } }));
