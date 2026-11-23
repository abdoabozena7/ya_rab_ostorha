import assert from "node:assert/strict";
import test from "node:test";
import { SpatialIndex } from "../src/core/spatial-index.js";
import {
  DEFAULT_SURVEILLANCE_ZONES,
  DISPATCH_RULESET,
  GTA_COVER_ESCAPE_M,
  GTA_COVER_STAR_DECAY_S,
  GTA_OPEN_ESCAPE_BASE_M,
  GTA_SEARCH_GRACE_S,
  GTA_STAR_DECAY_S,
  createDispatchResponse,
  isDispatchTracked,
  updateDispatchEscape,
  updateDispatchTracking,
} from "../src/core/pursuit-dispatch.js";
import {
  TACTICAL_SIGHT_RANGE_M,
  createPursuitResponse,
  gtaInSight,
  pursuitResponseSnapshot,
  updatePursuitResponse,
} from "../src/core/pursuit-response.js";

function makeTacticalWorld({
  tacticalPursuit = "gta-tactical-v1",
  wantedLevel = 3,
  player = {},
  patrols = [],
  statics = [],
  surveillanceZones = DEFAULT_SURVEILLANCE_ZONES,
} = {}) {
  const ego = {
    id: "player",
    type: "vehicle",
    x: -200,
    z: 0,
    heading: 0,
    speed: 14,
    gtaSlipMps: 0,
    width: 2.0,
    length: 4.6,
    roadId: "civic-ave",
    curbSupportId: null,
    ...player,
  };
  const patrolSet = new Set(
    patrols.map((p, idx) => ({
      id: `patrol-${idx + 1}`,
      type: "vehicle",
      x: -200,
      z: -125,
      heading: 0,
      speed: 12,
      health: 85,
      aiState: "PURSUIT",
      width: 1.9,
      length: 4.5,
      ...p,
    })),
  );
  const response = createPursuitResponse();
  response.dispatch = createDispatchResponse();
  const world = {
    tick: 0,
    player: ego,
    statics,
    staticIndex: new SpatialIndex(statics),
    pursuit: {
      variant: "gta",
      street: true,
      phase: "running",
      wantedLevel,
      playerStart: { x: -260, z: -80 },
      patrols: patrolSet,
      stepEvents: [],
      response,
      gta: {
        config: Object.freeze({
          ruleset: DISPATCH_RULESET,
          surveillanceZones,
          ...(tacticalPursuit ? { tacticalPursuit } : {}),
        }),
        fadeStars: wantedLevel,
        lostTicks: 0,
        heat: 0.4,
      },
    },
  };
  return world;
}

function stepTacticalTick(world) {
  world.tick += 1;
  const event = updatePursuitResponse(world, false);
  const escaped = updateDispatchEscape(world, isDispatchTracked(world.pursuit.response));
  return { event, escaped };
}

test("1. No endless ZONE_TRACKED trap inside surveillance zones under gta-tactical-v1 (while legacy keeps ZONE_TRACKED)", () => {
  // Player at (-200, 0) is squarely inside DEFAULT_SURVEILLANCE_ZONES[0] ("civic": [-256..-156, -120..36]).
  const world = makeTacticalWorld({
    wantedLevel: 2,
    player: { x: -200, z: 0, speed: 16 },
    patrols: [{ x: -200, z: -120, heading: Math.PI }], // 120 m away (> 110 m sight range)
  });
  // Seed prior lastSeen > 48 m away so open-road separation holds once grace expires.
  world.pursuit.response.lastSeen = Object.freeze({
    x: -255, z: 0, vx: 12, vz: 0, speed: 12, heading: Math.PI / 2, roadId: "civic-ave", tick: 0, lastSeenTick: 0,
  });

  // Negative control: legacy dispatch-v1 stays ZONE_TRACKED inside the exact same zone even with 0 units in contact.
  const legacyWorld = makeTacticalWorld({
    tacticalPursuit: null,
    wantedLevel: 2,
    player: { x: -200, z: 0, speed: 16 },
    patrols: [{ x: -200, z: -120, heading: Math.PI }],
  });
  legacyWorld.tick = 1;
  updatePursuitResponse(legacyWorld, false);
  assert.equal(legacyWorld.pursuit.response.unitsInContact, 0);
  assert.deepEqual(legacyWorld.pursuit.response.dispatch.zoneIds, ["civic"]);
  assert.equal(legacyWorld.pursuit.response.dispatch.state, "ZONE_TRACKED");

  // Tactical v1: zoneIds are still recorded for HUD, but state transitions LAST_KNOWN -> SEARCHING -> COOLING_DOWN!
  const seenStates = [];
  for (let i = 0; i < 185; i++) {
    stepTacticalTick(world);
    const st = world.pursuit.response.dispatch.state;
    if (seenStates.at(-1) !== st) seenStates.push(st);
  }
  assert.equal(world.pursuit.response.unitsInContact, 0);
  assert.deepEqual(world.pursuit.response.dispatch.zoneIds, ["civic"]);
  assert.notEqual(world.pursuit.response.dispatch.state, "ZONE_TRACKED");
  assert.deepEqual(seenStates, ["LAST_KNOWN", "SEARCHING", "COOLING_DOWN"]);
  assert.equal(world.pursuit.response.stage, "clearing");
  assert.equal(world.pursuit.response.dispatch.coolingDown, true);
});

test("2. Star-by-Star GTA Decay (3★ -> 2★ -> 1★ -> 0★ Escaped) at exact 4.0s open-road intervals", () => {
  assert.equal(GTA_SEARCH_GRACE_S, 3.0);
  assert.equal(GTA_STAR_DECAY_S, 4.0);
  assert.equal(GTA_OPEN_ESCAPE_BASE_M, 80);

  const world = makeTacticalWorld({
    wantedLevel: 3,
    player: { x: -180, z: 0, speed: 15 },
    patrols: [{ x: -180, z: -125, heading: Math.PI }], // 125 m away >= 98 m (3★ threshold)
  });
  world.pursuit.response.lastSeen = Object.freeze({
    x: -245, z: 0, vx: 15, vz: 0, speed: 15, heading: Math.PI / 2, roadId: "civic-ave", tick: 0, lastSeenTick: 0,
  });

  // 179 ticks (< 3.0s grace): still SEARCHING, 3 stars intact
  for (let i = 0; i < 179; i++) {
    const { escaped } = stepTacticalTick(world);
    assert.equal(escaped, false);
  }
  assert.equal(world.pursuit.wantedLevel, 3);
  assert.equal(world.pursuit.response.dispatch.state, "SEARCHING");

  // Next 240 ticks (ticks 180..419 => 4.0s of COOLING_DOWN): drops 3★ -> 2★ on the 240th cooldown tick
  let escaped = false;
  for (let i = 0; i < 239; i++) {
    ({ escaped } = stepTacticalTick(world));
    assert.equal(escaped, false);
    assert.equal(world.pursuit.wantedLevel, 3);
    assert.equal(world.pursuit.response.dispatch.state, "COOLING_DOWN");
  }
  ({ escaped } = stepTacticalTick(world)); // 240th cooldown tick (world.tick === 419)
  assert.equal(escaped, false);
  assert.equal(world.pursuit.wantedLevel, 2);
  assert.equal(world.pursuit.gta.fadeStars, 2);
  assert.equal(world.pursuit.stepEvents.length, 1);
  assert.deepEqual(world.pursuit.stepEvents[0], {
    type: "wanted_changed",
    tick: world.tick,
    wantedLevel: 2,
    previousWantedLevel: 3,
    reason: "los-distance-decay",
  });

  // Next 240 ticks (4.0s): drops 2★ -> 1★, still NOT escaped
  for (let i = 0; i < 239; i++) {
    ({ escaped } = stepTacticalTick(world));
    assert.equal(escaped, false);
    assert.equal(world.pursuit.wantedLevel, 2);
  }
  ({ escaped } = stepTacticalTick(world));
  assert.equal(escaped, false);
  assert.equal(world.pursuit.wantedLevel, 1);
  assert.equal(world.pursuit.stepEvents.length, 2);
  assert.equal(world.pursuit.stepEvents[1].wantedLevel, 1);
  assert.equal(world.pursuit.stepEvents[1].previousWantedLevel, 2);

  // Final 240 ticks (4.0s): drops 1★ -> 0★ and returns true ONLY on reaching 0★!
  for (let i = 0; i < 239; i++) {
    ({ escaped } = stepTacticalTick(world));
    assert.equal(escaped, false);
    assert.equal(world.pursuit.wantedLevel, 1);
  }
  ({ escaped } = stepTacticalTick(world));
  assert.equal(escaped, true);
  assert.equal(world.pursuit.wantedLevel, 0);
  assert.equal(world.pursuit.response.clearProgress, 1);
  assert.equal(world.pursuit.response.strobeIntensity, 0);
  assert.equal(world.pursuit.stepEvents.length, 3);
  assert.deepEqual(
    world.pursuit.stepEvents.map(e => [e.previousWantedLevel, e.wantedLevel, e.reason]),
    [
      [3, 2, "los-distance-decay"],
      [2, 1, "los-distance-decay"],
      [1, 0, "los-distance-decay"],
    ],
  );
  assert.equal(world.pursuit.stepEvents[1].tick - world.pursuit.stepEvents[0].tick, 240);
  assert.equal(world.pursuit.stepEvents[2].tick - world.pursuit.stepEvents[1].tick, 240);
});

test("3. Short-Distance Guard: obstructed open-road player at 45 m moving fast stays SEARCHING and never decays stars", () => {
  const skyscraper = {
    id: "tower-1",
    type: "static",
    kind: "building",
    x: -200,
    z: -22,
    width: 28,
    length: 14,
    heading: 0,
    height: 42,
  };
  const world = makeTacticalWorld({
    wantedLevel: 3,
    player: { x: -200, z: 0, speed: 15, curbSupportId: null },
    patrols: [{ x: -200, z: -45, heading: 0 }], // 45 m away behind skyscraper (< 98 m open road, < 52 m cover, speed > 5.5)
    statics: [skyscraper],
  });
  world.pursuit.response.lastSeen = Object.freeze({
    x: -260, z: 0, vx: 14, vz: 0, speed: 14, heading: Math.PI / 2, roadId: "civic-ave", tick: 0, lastSeenTick: 0,
  });

  const [patrol] = world.pursuit.patrols;
  assert.equal(gtaInSight(world, patrol, world.player), false, "skyscraper blocks 3D sightline even inside 110 m cone");

  for (let i = 0; i < 600; i++) {
    const { escaped } = stepTacticalTick(world);
    assert.equal(escaped, false);
  }
  assert.equal(world.pursuit.response.unitsInContact, 0);
  assert.equal(world.pursuit.response.dispatch.state, "SEARCHING");
  assert.equal(world.pursuit.response.dispatch.coolingDown, false);
  assert.equal(world.pursuit.response.dispatch.hiddenInCover, false);
  assert.equal(world.pursuit.wantedLevel, 3);
  assert.equal(world.pursuit.response.clearProgress, 0);
  assert.equal(world.pursuit.stepEvents.length, 0);
});

test("4. Hiding Behind Buildings / Alley Cover (hiddenInCover): cools down at 58 m (< 98 m open-road threshold) and decays stars in 3.2s", () => {
  assert.equal(GTA_COVER_ESCAPE_M, 52);
  assert.equal(GTA_COVER_STAR_DECAY_S, 3.2);

  const blockerBuilding = {
    id: "alley-tower-a",
    type: "static",
    kind: "building",
    x: -200,
    z: -24,
    width: 32,
    length: 16,
    heading: 0,
    height: 36,
  };
  const world = makeTacticalWorld({
    wantedLevel: 3,
    player: { x: -200, z: 0, speed: 1.4, curbSupportId: "alley-1" },
    patrols: [{ x: -200, z: -58, heading: 0 }], // 58 m: < 98 m open-road threshold for 3★, >= 52 m cover threshold!
    statics: [blockerBuilding],
  });
  world.pursuit.response.lastSeen = Object.freeze({
    x: -245, z: 0, vx: 10, vz: 0, speed: 10, heading: Math.PI / 2, roadId: "civic-ave", tick: 0, lastSeenTick: 0,
  });

  // Pass 3.0s search grace (180 ticks) -> enters COOLING_DOWN with hiddenInCover === true
  for (let i = 0; i < 180; i++) stepTacticalTick(world);
  assert.equal(world.pursuit.response.unitsInContact, 0);
  assert.equal(world.pursuit.response.dispatch.minEscapeDistanceM, 98);
  assert.equal(world.pursuit.response.dispatch.nearestPatrolM, 58);
  assert.equal(world.pursuit.response.dispatch.hiddenInCover, true);
  assert.equal(world.pursuit.response.dispatch.coolingDown, true);
  assert.equal(world.pursuit.response.dispatch.state, "COOLING_DOWN");
  assert.equal(world.pursuit.response.stage, "clearing");

  // Snapshot exposes tactical cover & star countdown telemetry cleanly
  const snap = pursuitResponseSnapshot(world.pursuit.response);
  assert.equal(snap.nearestPatrolM, 58);
  assert.equal(snap.dispatch.hiddenInCover, true);
  assert.equal(snap.dispatch.coolingDown, true);
  assert.equal(snap.dispatch.minEscapeDistanceM, 98);
  assert.ok(snap.dispatch.nextStarDropS > 0 && snap.dispatch.nextStarDropS <= 3.2);

  // Advance remaining 191 ticks of first 192-tick (3.2s) cover star window -> drops 3★ -> 2★!
  for (let i = 0; i < 191; i++) stepTacticalTick(world);
  assert.equal(world.pursuit.wantedLevel, 2);
  assert.equal(world.pursuit.stepEvents.at(-1)?.reason, "hidden-cover-decay");

  // Complete remaining 2 stars (2 * 192 ticks) -> escapes cleanly!
  let escaped = false;
  for (let i = 0; i < 384; i++) ({ escaped } = stepTacticalTick(world));
  assert.equal(escaped, true);
  assert.equal(world.pursuit.wantedLevel, 0);

  // Also verify 2-building alley geometry cover when curbSupportId is null
  const alleyWorld = makeTacticalWorld({
    wantedLevel: 2,
    player: { x: 0, z: 0, speed: 0.8, curbSupportId: null },
    patrols: [{ x: 0, z: -60, heading: 0 }],
    statics: [
      { id: "b1", type: "static", kind: "building", x: 0, z: -18, width: 24, length: 12, heading: 0, height: 30 },
      { id: "b2", type: "static", kind: "building", x: 14, z: 2, width: 12, length: 20, heading: 0, height: 28 },
    ],
  });
  alleyWorld.pursuit.response.lastSeen = Object.freeze({
    x: -42, z: 0, vx: 8, vz: 0, speed: 8, heading: 0, roadId: "alley", tick: 0, lastSeenTick: 0,
  });
  for (let i = 0; i < 180; i++) stepTacticalTick(alleyWorld);
  assert.equal(alleyWorld.pursuit.response.dispatch.hiddenInCover, true);
  assert.equal(alleyWorld.pursuit.response.dispatch.state, "COOLING_DOWN");

  // Negative control (Q07): resting on an unoccluded boulevard sidewalk (curbSupportId truthy)
  // with an unoccluded patrol 60 m away (facing away so unitsInContact === 0) must NOT count as hiddenInCover!
  const openSidewalkWorld = makeTacticalWorld({
    wantedLevel: 3,
    player: { x: 0, z: 0, speed: 0.5, curbSupportId: "boulevard-sidewalk-1" },
    patrols: [{ x: 0, z: -60, heading: Math.PI }], // 60 m away, facing away (-z), zero buildings between them
    statics: [],
  });
  openSidewalkWorld.pursuit.response.lastSeen = Object.freeze({
    x: -45, z: 0, vx: 8, vz: 0, speed: 8, heading: 0, roadId: "boulevard", tick: 0, lastSeenTick: 0,
  });
  for (let i = 0; i < 200; i++) stepTacticalTick(openSidewalkWorld);
  assert.equal(openSidewalkWorld.pursuit.response.unitsInContact, 0);
  assert.equal(openSidewalkWorld.pursuit.response.dispatch.hiddenInCover, false);
  assert.equal(openSidewalkWorld.pursuit.response.dispatch.coolingDown, false);
  assert.equal(openSidewalkWorld.pursuit.response.dispatch.state, "SEARCHING");
  assert.equal(openSidewalkWorld.pursuit.wantedLevel, 3);
});

test("5. Instant Re-Spotting Cancellation resets cooldown, partial star progress, and snaps back to VISUALLY_SPOTTED", () => {
  const world = makeTacticalWorld({
    wantedLevel: 3,
    player: { x: 0, z: 0, speed: 12 },
    patrols: [{ x: 0, z: -120, heading: 0 }],
  });
  world.pursuit.response.lastSeen = Object.freeze({
    x: -65, z: 0, vx: 12, vz: 0, speed: 12, heading: Math.PI / 2, roadId: "ave", tick: 0, lastSeenTick: 0,
  });

  // Drop 1 star (3★ -> 2★) and advance 70% into the next star (168 / 240 ticks => 0.7)
  for (let i = 0; i < 179 + 240 + 168; i++) stepTacticalTick(world);
  assert.equal(world.pursuit.wantedLevel, 2);
  assert.equal(world.pursuit.response.dispatch.coolingDown, true);
  assert.equal(world.pursuit.response.dispatch.starProgress, 0.7);
  assert.ok(world.pursuit.response.clearProgress > 0.5);

  // Patrol moves into unobstructed sight at 40 m facing player (within TACTICAL_SIGHT_RANGE_M = 110 m)
  const [patrol] = world.pursuit.patrols;
  patrol.x = 0;
  patrol.z = -40;
  patrol.heading = 0; // +z faces player at (0, 0)
  assert.equal(TACTICAL_SIGHT_RANGE_M, 110);
  assert.equal(gtaInSight(world, patrol, world.player), true);

  const { event, escaped } = stepTacticalTick(world);
  assert.equal(escaped, false);
  assert.equal(event, "reacquired");
  assert.equal(world.pursuit.response.unitsInContact, 1);
  assert.equal(world.pursuit.response.stage, "contact");
  assert.equal(world.pursuit.response.dispatch.state, "VISUALLY_SPOTTED");
  assert.equal(world.pursuit.response.dispatch.coolingDown, false);
  assert.equal(world.pursuit.response.dispatch.starDecayTicks, 0);
  assert.equal(world.pursuit.response.dispatch.starProgress, 0);
  assert.equal(world.pursuit.response.dispatch.nextStarDropS, null);
  assert.equal(world.pursuit.response.clearProgress, 0);
  assert.equal(world.pursuit.wantedLevel, 2, "earned remaining stars stay at 2★ while partial decay resets");
  assert.equal(world.pursuit.gta.lostTicks, 0);
  assert.ok(world.pursuit.response.strobeIntensity >= 0.55);

  // Breaking LOS again requires a fresh 3.0s grace + full 4.0s star decay from 0%
  patrol.z = -130;
  world.player.x = 60;
  stepTacticalTick(world);
  assert.equal(world.pursuit.response.dispatch.state, "LAST_KNOWN");
  assert.equal(world.pursuit.response.dispatch.coolingDown, false);
});

test("6. Strobe Intensity Transitions: high in VISUALLY_SPOTTED, calmer in SEARCHING, soft fade in COOLING_DOWN, 0 on escape", () => {
  const world = makeTacticalWorld({
    wantedLevel: 1,
    player: { x: 0, z: 0, speed: 14 },
    patrols: [{ x: 0, z: -30, heading: 0 }], // unobstructed 30 m ahead -> VISUALLY_SPOTTED
  });

  // 1) VISUALLY_SPOTTED: 0.55..1.0 and qualifies dispatch.escapeEligible after 1.0s (60 ticks)
  assert.equal(world.pursuit.response.dispatch.escapeEligible, false);
  for (let i = 0; i < 59; i++) stepTacticalTick(world);
  assert.equal(world.pursuit.response.dispatch.escapeEligible, false);
  stepTacticalTick(world);
  assert.equal(world.pursuit.response.dispatch.mobileTrackTicks, 60);
  assert.equal(world.pursuit.response.dispatch.escapeEligible, true);
  assert.equal(world.pursuit.response.dispatch.lastSampleTick, world.tick);
  const spottedStrobe = world.pursuit.response.strobeIntensity;
  assert.equal(world.pursuit.response.dispatch.state, "VISUALLY_SPOTTED");
  assert.ok(spottedStrobe >= 0.55 && spottedStrobe <= 1.0, `expected 0.55..1.0, got ${spottedStrobe}`);

  // 2) Move player 60 m away & patrol 95 m away (> 86 m 1★ open escape): SEARCHING -> 0.16..0.36
  const [patrol] = world.pursuit.patrols;
  world.player.x = 60;
  patrol.x = 60;
  patrol.z = -95;
  patrol.heading = Math.PI; // facing away, 95 m > earshot, out of cone -> unitsInContact === 0
  for (let i = 0; i < 100; i++) stepTacticalTick(world);
  const searchingStrobe = world.pursuit.response.strobeIntensity;
  assert.equal(world.pursuit.response.dispatch.state, "SEARCHING");
  assert.ok(searchingStrobe >= 0.16 && searchingStrobe <= 0.36, `expected 0.16..0.36, got ${searchingStrobe}`);
  assert.ok(searchingStrobe < spottedStrobe);

  // 3) Advance into COOLING_DOWN -> 0.05..0.16 and fading lower as clearProgress rises
  for (let i = 0; i < 90; i++) stepTacticalTick(world);
  const earlyCooldownStrobe = world.pursuit.response.strobeIntensity;
  assert.equal(world.pursuit.response.dispatch.state, "COOLING_DOWN");
  assert.ok(earlyCooldownStrobe >= 0.05 && earlyCooldownStrobe <= 0.16, `expected 0.05..0.16, got ${earlyCooldownStrobe}`);
  assert.ok(earlyCooldownStrobe < searchingStrobe);

  for (let i = 0; i < 150; i++) stepTacticalTick(world);
  const lateCooldownStrobe = world.pursuit.response.strobeIntensity;
  assert.ok(lateCooldownStrobe < earlyCooldownStrobe, "strobe fades lower as cooldown progresses");

  // 4) Finish final star -> strobe hits 0 upon escape and escapeEligible remains latched true
  let escaped = false;
  for (let i = 0; i < 100 && !escaped; i++) ({ escaped } = stepTacticalTick(world));
  assert.equal(escaped, true);
  assert.equal(world.pursuit.wantedLevel, 0);
  assert.equal(world.pursuit.response.strobeIntensity, 0);
  assert.equal(world.pursuit.response.dispatch.escapeEligible, true);
  assert.equal(pursuitResponseSnapshot(world.pursuit.response).strobeIntensity, 0);

  // Also verify mobileNearbyTactical qualifies at 95 m (<= 110 m) when patrol has accepted travel
  const mobileWorld = makeTacticalWorld({
    wantedLevel: 1,
    player: { x: 0, z: 0, speed: 12 },
    patrols: [{ x: 0, z: -95, heading: Math.PI, speed: 10 }],
  });
  const [mobilePatrol] = mobileWorld.pursuit.patrols;
  for (let i = 0; i < 60; i++) {
    mobilePatrol.previous = { x: mobilePatrol.x, z: mobilePatrol.z - 0.2 };
    stepTacticalTick(mobileWorld);
  }
  assert.equal(mobileWorld.pursuit.response.dispatch.escapeEligible, true);

  // Also check legacy pursuitResponseSnapshot shape is untouched when !dispatch.tactical
  const legacyResp = createPursuitResponse();
  assert.deepEqual(pursuitResponseSnapshot(legacyResp), {
    stage: "search",
    pressure: 0,
    clearProgress: 0,
    unitsInContact: 0,
  });
  legacyResp.dispatch = createDispatchResponse();
  assert.deepEqual(pursuitResponseSnapshot(legacyResp), {
    stage: "search",
    pressure: 0,
    clearProgress: 0,
    unitsInContact: 0,
    dispatch: { state: "LOST", zoneIds: [], lastReportTick: null },
  });
});

test("gtaInSight enforces 22 m unobstructed earshot, 132° tactical cone up to 110 m, and 15 m closeProximityContact", () => {
  const world = makeTacticalWorld({
    wantedLevel: 2,
    player: { x: 0, z: 0, speed: 5 },
    patrols: [{ x: 0, z: 18, heading: 0 }], // patrol at (0, 18) facing +z (away from player at (0, 0)), dist = 18 m <= 22 m earshot
  });
  const [patrol] = world.pursuit.patrols;
  assert.equal(gtaInSight(world, patrol, world.player), true, "unobstructed <= 22 m earshot has 360° awareness");

  // Put a wall between patrol (0, 18) and player (0, 0) -> blocked even at 18 m or 12 m!
  const wall = { id: "wall-1", type: "static", kind: "building", x: 0, z: 9, width: 14, length: 4, heading: 0, height: 12 };
  world.statics = [wall];
  world.staticIndex = new SpatialIndex(world.statics);
  assert.equal(gtaInSight(world, patrol, world.player), false, "building blocks earshot sightline");
  patrol.z = 12;
  updatePursuitResponse(world, false);
  assert.equal(world.pursuit.response.unitsInContact, 0, "12 m behind a building does not trigger closeProximityContact");

  // Remove wall: 12 m behind patrol triggers contact; 50 m behind patrol (outside cone & earshot) does NOT!
  world.statics = [];
  world.staticIndex = new SpatialIndex([]);
  updatePursuitResponse(world, false);
  assert.equal(world.pursuit.response.unitsInContact, 1);

  patrol.z = 50; // patrol at (0, 50) facing +z, player is 50 m directly behind (-z) -> local.forward = -50
  assert.equal(gtaInSight(world, patrol, world.player), false);
  updatePursuitResponse(world, false);
  assert.equal(world.pursuit.response.unitsInContact, 0);

  // Turn patrol toward player (+PI -> facing -z) at 95 m (<= 110 m tactical, > 65 m legacy) -> spotted!
  patrol.z = 95;
  patrol.heading = Math.PI;
  assert.equal(gtaInSight(world, patrol, world.player), true);
  patrol.z = 112;
  assert.equal(gtaInSight(world, patrol, world.player), false);
});
