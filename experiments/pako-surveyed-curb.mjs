import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { METRO_CURB_SUPPORT } from "../src/core/pako-curb.js";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { requireDispatchScan } from "../src/rl/pursuit-shield.js";
import { PURSUIT_SCAN_RAYS, PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { followConnectedReference } from "./pako-reference-route.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const seed = "pako-curb-local-dev";
const cases = [
  { name: "surveyed", shutterX: -230 },
  { name: "shifted-shutter", shutterX: -232 },
  { name: "paved", shutterX: -230, support: false },
  { name: "clear", reviewTicks: 1800 },
  { name: "occupied", shutterX: -230, pedestrians: 17, reviewTicks: 1800 },
  { name: "populated-stock", shutterX: -230, traffic: 2 },
  { name: "populated-preview", shutterX: -230, traffic: 2, preview: true },
];
const write = (filename, result) =>
  writeFileSync(join(output, filename), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
write("protocol.json", {
  seed, cases, terrain: METRO_CURB_SUPPORT, npcPreview: PATROL_TRAFFIC_PREVIEW,
  scope: "Same surveyed Tahrir curb, one intact patrol, actual primary Dispatch scanner and unchanged physical guard. Scripted development only.",
  oracle: "Admitted surface returns precede actual curb use and paved rejoin. Continue 10 m and take the existing public route all the way to terminal. Keep the complete contact and road-denial counts, including NPC impacts.",
});

function observeShutter(ego, site, scan) {
  if (!site || ego.x > site.minX - 3 || Math.abs(angleDelta(ego.heading, Math.PI / 2)) > .08 ||
      Math.abs(ego.speed) > 2.8) return null;
  const face = [-1, 0, 1].map(i => {
    const { kind, rangeM } = scan.rays[(i + PURSUIT_SCAN_RAYS) % PURSUIT_SCAN_RAYS];
    if (kind !== "static" || rangeM < 15 || rangeM > 30) return null;
    const yaw = ego.heading + i * 2 * Math.PI / PURSUIT_SCAN_RAYS;
    return { beam: i, rangeM, x: ego.x + rangeM * Math.sin(yaw), z: ego.z + rangeM * Math.cos(yaw) };
  });
  if (face.some(point => !point)) return null;
  const faceX = face[1].x;
  if (face.some(point => Math.abs(point.x - faceX) > .25) ||
      faceX < site.minX + 16 || faceX > site.maxX - 22) return null;
  return { tick: scan.tick, face, faceX, home: ego.z, shoulder: site.maxZ - 1.52,
    enter: site.minX - 3, leave: Math.min(site.maxX - 18, faceX + 7) };
}

const smooth = value => .5 - .5 * Math.cos(Math.PI * clamp(value, 0, 1));
function surveyAction(ego, home, route) {
  const lane = x => route ? route.home + (route.shoulder - route.home) *
    (smooth((x - route.enter) / 17) - smooth((x - route.leave) / 17)) : home;
  const z = lane(ego.x), dzdx = (lane(ego.x + .1) - z) / .1;
  const heading = Math.PI / 2 - Math.atan((z - ego.z) * .45 + dzdx);
  return { steer: clamp(angleDelta(heading, ego.heading) * 1.7, -.7, .7),
    throttle: ego.speed < 2.30 ? .8 : 0, brake: 0, gear: 1 };
}

function run({ name, shutterX, support = true, traffic = 0, pedestrians = 0, preview = false, reviewTicks = 7200 }) {
  const env = new GtaPursuitEnv();
  env.reset({ seed, traffic, pedestrians, shield: true, config: {
    ruleset: "dispatch-v1", wantedLevelMax: 1, maxActivePatrols: 1,
    ...(support && { curbSupport: METRO_CURB_SUPPORT }),
    ...(preview && { patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW }),
  } });
  const { world } = env, { player, pursuit } = world;
  const [patrol] = pursuit.patrols;
  assert.equal(pursuit.patrols.size, 1);
  const ambient = world.actors.filter(actor => actor !== player && actor !== patrol);
  assert.equal(ambient.length, traffic + pedestrians);
  const person = pedestrians ? ambient.find(actor => actor.id === "person-14") : null;
  if (pedestrians) {
    assert.ok(person);
    world.command({ type: "pedestrian-motion", mode: "stop", id: person.id }, false);
  }
  const shutter = shutterX === undefined ? null : Object.freeze({
    id: "dev-road-shutter", x: shutterX, z: -112.175, width: 1, length: 13.65,
    heading: 0, height: 1.6, type: "static", kind: "barrier",
  });
  if (shutter) {
    assert.ok(world.free(shutter, .15));
    world.statics.push(shutter);
    world.staticIndex = new SpatialIndex(world.statics);
    pursuit.gta.scanner = new PursuitScanner();
    pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  }
  const roads = world.roads, solids = [...world.statics], home = player.z;
  const accepted = createHash("sha256"), trace = [], contacts = [];
  let plan = null, path = null, cursor = 0, entry = null, returned = null, onwardAt = null;
  let denied = 0, lostAt = null, raisedM = 0, peakShoulderSpeed = 0, pedestrianYield = null;
  const snapshot = () => ({ tick: world.tick, x: player.x, z: player.z, heading: player.heading,
    speed: player.speed, y: player.y ?? 0, distance: player.distance, support: player.curbSupportId ?? null });
  const step = world.step.bind(world);
  world.step = () => {
    step();
    const pose = snapshot(), guard = pursuit.metrics.guard;
    accepted.update(JSON.stringify(pose));
    denied += Number(guard === "road-boundary");
    if (patrol.health <= 0 || (pursuit.phase === "running" &&
        (!world.actors.includes(patrol) || !pursuit.patrols.has(patrol)))) lostAt ??= world.tick;
    if (pose.support) {
      entry ??= pose;
      peakShoulderSpeed = Math.max(peakShoulderSpeed, Math.hypot(pose.speed, player.gtaSlipMps));
    } else if (entry && bodyOnRoad(player, roads)) returned ??= pose;
    raisedM = Math.max(raisedM, pose.y);
    if (person && guard === "curb-pedestrian" && player.blockedBy === person.id)
      pedestrianYield ??= { ...pose, source: "curb-plant" };
    if (person) assert.ok(!overlaps(player, person));
  };
  while (world.tick < reviewTicks && pursuit.phase === "running") {
    const scan = requireDispatchScan(world);
    if (!plan) plan = observeShutter(player, pursuit.gta.curb, scan);
    if (reviewTicks === 7200 && returned && player.distance - returned.distance >= 10 && !onwardAt) {
      const road = world.district.drivingRoads.find(candidate => candidate.id === "civic-avenue");
      const goal = { ...districtRoadPose(road, 76, 1), roadId: road.id };
      path = Object.freeze(planDistrictRoute(world.district, player, goal).map(Object.freeze));
      assert.ok(path.length > 2, "Survey return must support a real onward map route");
      onwardAt = snapshot();
    }
    const next = path ? followConnectedReference(player, path, cursor) : { action: surveyAction(player, home, plan), cursor };
    cursor = next.cursor;
    const speedBefore = player.speed;
    const personReturn = person && !pedestrianYield && scan.tracks.find(track => track.kind === "pedestrian" &&
      track.ageS === 0 && Math.hypot(track.observedXM - person.x, track.observedZM - person.z) <= person.radius + .1);
    const { info } = env.step(next.action);
    if (personReturn && !pedestrianYield && info.shield.reason === "pedestrian" &&
        info.appliedCommand?.targetSpeed === 0 && player.speed < speedBefore - 1e-4)
      pedestrianYield = { ...snapshot(), source: "range-guard", speedBefore, scanTick: scan.tick,
        observedSurface: [personReturn.observedXM, personReturn.observedZM] };
    const hits = info.events.filter(event => event.type === "ambient_collision" ||
      event.fresh && ["patrol_collision", "static_or_civilian_hit"].includes(event.type));
    contacts.push(...hits);
    if (world.tick % 30 === 0 || hits.length || pursuit.phase !== "running") {
      trace.push({ ...snapshot(), action: next.action, guard: info.shield, reason: player.reason,
        patrol: [patrol.x, patrol.z, patrol.speed], contacts: hits });
    }
    assert.ok(solids.every(body => world.statics.includes(body)) && ambient.every(actor => world.actors.includes(actor)));
  }
  const egoContacts = contacts.filter(event => event.type !== "ambient_collision").length;
  const ambientContacts = contacts.length - egoContacts, phase = pursuit.phase, qualified = pursuit.response.dispatch.escapeEligible;
  const onwardM = returned ? player.distance - returned.distance : 0;
  const full = Boolean(phase === "escaped" && qualified && entry && returned && onwardAt && raisedM >= .01 &&
    peakShoulderSpeed <= 2.8 + 1e-8 && onwardM >= 10 && !denied && !contacts.length && lostAt === null && patrol.distance > 7);
  const summary = { name, phase, ticks: world.tick, full, qualified, plan, entry, returned, onwardAt, onwardM,
    raisedM, peakShoulderSpeed, patrolM: patrol.distance, endX: player.x, endZ: player.z, denied, lostAt,
    egoContacts, ambientContacts, pedestrianYield, accepted: accepted.digest("hex") };
  console.log(JSON.stringify(summary));
  return { ...summary, contacts, trace };
}

const rows = cases.map(run);
const [surveyed, shifted, paved, clear, occupied, stock, preview] = rows;
const qualifiedSparse = Number(surveyed.full) + Number(shifted.full), populatedPreviewContacts = preview.contacts.length;
const passed = qualifiedSparse === 2 && surveyed.plan?.faceX !== shifted.plan?.faceX &&
  surveyed.plan?.leave !== shifted.plan?.leave &&
  paved.phase === "timeout" && !paved.plan && !paved.entry && !paved.egoContacts &&
  !clear.plan && !clear.entry && clear.endX > -205 && !clear.egoContacts &&
  occupied.pedestrianYield && !occupied.returned && !occupied.egoContacts &&
  stock.phase === "escaped" && stock.egoContacts === 0 && stock.ambientContacts > 0 && preview.full &&
  stock.accepted === preview.accepted;
write("surveyed-curb.json", { passed: Boolean(passed), qualifiedSparse, populatedPreviewContacts, rows });
assert.ok(passed, "The surveyed curb references or protected physical controls did not meet the complete oracle");
