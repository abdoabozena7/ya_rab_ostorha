import assert from "node:assert/strict";
import test from "node:test";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import {
  AGGRESSIVE_CHASE_PRESENCE,
  aggressiveDeploymentBounds,
  aggressiveInitialSpeed,
  aggressivePatrolPace,
  isAggressiveChase,
  recycleTrailingChasePatrols,
  scoreAggressiveDeploymentSlots,
} from "../src/core/pako-aggressive-police.js";
import { gtaLocal } from "../src/core/pursuit-gta.js";
import { gtaLineClear } from "../src/core/pursuit-response.js";
import { World } from "../src/core/world.js";

function metroLanes(world, car) {
  const pad = car.length / 2 + 0.3;
  return world.drivingRoads
    .filter(
      (r) =>
        !r.parkingBay &&
        !r.supportApron &&
        r.max - r.min > pad * 2 &&
        r.width / 2 >= Math.abs(r.laneOffsetM ?? 0) + car.width / 2 + 0.12,
    )
    .flatMap((road) =>
      (road.flow ? [road.flow] : [1, -1]).map((sign) => ({
        road,
        sign,
        low: road.min + pad,
        high: road.max - pad,
      })),
    );
}

function candidateSlots(lanes, ego, minRange, maxRange) {
  const slots = [];
  for (const lane of lanes) {
    const along = ego[lane.road.axis];
    const low = Math.max(lane.low, along - maxRange);
    const high = Math.min(lane.high, along + maxRange);
    for (let at = low; at <= high; at += 3.5) {
      const clamped = Math.min(lane.high, Math.max(lane.low, at));
      const position = { ...districtRoadPose(lane.road, clamped, lane.sign), roadId: lane.road.id };
      const range = distance(ego, position);
      if (range < minRange || range > maxRange) continue;
      slots.push({ lane, position, score: 0 });
    }
  }
  return slots;
}

function makeAggressiveState(overrides = {}) {
  return {
    phase: "running",
    wantedLevel: 1,
    patrols: new Set(),
    response: {
      dispatch: { state: "ZONE_TRACKED" },
    },
    gta: {
      config: {
        ruleset: "dispatch-v1",
        chasePresence: AGGRESSIVE_CHASE_PRESENCE,
        minSpawnRadius: 15.5,
        npcSpeedMultiplier: 1,
      },
    },
    ...overrides,
  };
}

test("isAggressiveChase and aggressiveDeploymentBounds enforce vanguard (<2) vs staggered backup (>=2) and mid-chase ranges", () => {
  assert.equal(AGGRESSIVE_CHASE_PRESENCE, "city-chase-v1");
  assert.equal(isAggressiveChase(makeAggressiveState()), true);
  assert.equal(isAggressiveChase(null), false);
  assert.equal(isAggressiveChase({ gta: { config: { ruleset: "dispatch-v1" } } }), false);
  assert.equal(
    isAggressiveChase({ gta: { config: { ruleset: "legacy", chasePresence: AGGRESSIVE_CHASE_PRESENCE } } }),
    false,
  );
  assert.equal(
    isAggressiveChase({ gta: { config: { ruleset: "dispatch-v1", chasePresence: "other" } } }),
    false,
  );

  // Vanguard (< 2 patrols): { minRange: Math.max(17.5, minSpawn), maxRange: 33 }
  const vanguardLow = makeAggressiveState({
    patrols: new Set([{ id: "p1" }]),
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, minSpawnRadius: 15.5 } },
  });
  assert.deepEqual(aggressiveDeploymentBounds(vanguardLow, true), { minRange: 17.5, maxRange: 33 });
  assert.deepEqual(aggressiveDeploymentBounds(vanguardLow, false), { minRange: 26, maxRange: 58 });

  const vanguardWide = makeAggressiveState({
    patrols: new Set(),
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, minSpawnRadius: 21 } },
  });
  assert.deepEqual(aggressiveDeploymentBounds(vanguardWide, true), { minRange: 21, maxRange: 33 });

  // Backup opening wave (count >= 2): { minRange: 36, maxRange: 66 }
  const backupWave = makeAggressiveState({
    patrols: new Set([{ id: "p1" }, { id: "p2" }]),
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, minSpawnRadius: 16 } },
  });
  assert.deepEqual(aggressiveDeploymentBounds(backupWave, true), { minRange: 36, maxRange: 66 });
  assert.deepEqual(aggressiveDeploymentBounds(backupWave, false), { minRange: 26, maxRange: 58 });
});

test("opening vanguard (<2) places visible rear/cross-street units in 17.5..33 m while backup (>=2) staggers in 36..66 m with 20 m spacing", () => {
  const world = new World({ cityVersion: 4 }, "metro");
  const { player } = world;
  const state = makeAggressiveState();

  const probeCar = world.makeVehicle("test-patrol-probe", "sedan", {
    x: player.x,
    z: player.z,
    heading: player.heading,
  });
  const lanes = metroLanes(world, probeCar);

  // Deploy 6-patrol opening wave: 2 vanguard units (<2) in 17.5..33m, 4 backup units (>=2) staggered in 36..66m
  const waveTactics = ["tail", "flank", "intercept", "tail", "flank", "intercept"];
  const placed = [];
  for (const [i, tactic] of waveTactics.entries()) {
    const bounds = aggressiveDeploymentBounds(state, true);
    if (i < 2) assert.deepEqual(bounds, { minRange: 17.5, maxRange: 33 });
    else assert.deepEqual(bounds, { minRange: 36, maxRange: 66 });

    const car = { ...probeCar, id: `patrol-${i + 1}`, gtaAI: { order: i } };
    const ranked = scoreAggressiveDeploymentSlots(
      world,
      state,
      car,
      player,
      candidateSlots(lanes, player, bounds.minRange, bounds.maxRange),
      tactic,
      true,
    );
    const pick = ranked.find((s) => Number.isFinite(s.score) && bodyOnRoad({ ...car, ...s.position }, world.drivingRoads));
    assert.ok(pick, `expected valid opening slot for unit ${i + 1} (${tactic})`);
    Object.assign(car, pick.position);
    const rel = gtaLocal(player, car);
    const range = distance(player, car);
    const align = Math.cos(angleDelta(car.heading, player.heading));
    const inForwardCorridor = rel.forward > -2 && rel.forward < 42 && Math.abs(align) > 0.65 && Math.abs(rel.right) < 7.5;
    assert.equal(inForwardCorridor, false, `opening unit ${i + 1} (${tactic}) must not block starting forward corridor`);
    if (i < 2) {
      assert.ok(range >= 17.5 && range <= 33, `expected vanguard unit ${i + 1} in 17.5..33m, got ${range}`);
    } else {
      assert.ok(range >= 36 && range <= 66, `expected staggered backup unit ${i + 1} in 36..66m, got ${range}`);
    }
    assert.equal(overlaps(player, car, 0.65), false);
    state.patrols.add(car);
    placed.push({ car, rel, range, align });
  }

  // Vanguard #1 ("tail") is a close rear chaser in 18..31m aligned with player; Vanguard #2 ("flank") is a cross-street berth in 18..31m
  assert.ok(placed[0].rel.forward >= -31 && placed[0].rel.forward <= -17 && placed[0].align > 0.65);
  assert.ok(placed[0].range >= 18 && placed[0].range <= 31);
  assert.ok(Math.abs(placed[1].align) <= 0.65 && placed[1].range >= 18 && placed[1].range <= 31);

  // Backup units stagger progressively outward and stay well separated (20m spacing preference)
  const backupRanges = placed.slice(2).map((p) => p.range);
  assert.ok(Math.max(...backupRanges) - Math.min(...backupRanges) >= 12, "backup wave should stagger across 36..66m");
  assert.ok(distance(placed[2].car, placed[3].car) >= 18, "backup units should spread apart rather than clumping");

  // Near a Metro cross-street ahead (approaching civic-avenue x=-183 from x=-205) for vanguard unit #2 (count = 1 < 2):
  const junctionPlayer = { ...player, x: -205, z: -109.3, heading: Math.PI / 2 };
  const junctionState = makeAggressiveState({ patrols: new Set([placed[0].car]) });
  const jBounds = aggressiveDeploymentBounds(junctionState, true);
  const junctionSlots = scoreAggressiveDeploymentSlots(
    world,
    junctionState,
    { ...probeCar, id: "patrol-junction", gtaAI: { order: 1 } },
    junctionPlayer,
    candidateSlots(lanes, junctionPlayer, jBounds.minRange, jBounds.maxRange),
    "intercept",
    true,
  );
  const junctionPick = junctionSlots[0];
  const jRel = gtaLocal(junctionPlayer, junctionPick.position);
  const jRange = distance(junctionPlayer, junctionPick.position);
  const jAlign = Math.cos(angleDelta(junctionPick.position.heading, junctionPlayer.heading));
  assert.ok(Math.abs(jAlign) <= 0.65, "expected cross-street intercept heading near junction");
  assert.ok(jRel.forward > 10 && jRange >= 18 && jRange <= 33);
  assert.equal(gtaLineClear(world, junctionPlayer, junctionPick.position.x - junctionPlayer.x, junctionPick.position.z - junctionPlayer.z, jRange), true);

  const forwardLaneSlot = junctionSlots.find((s) => {
    const rel = gtaLocal(junctionPlayer, s.position);
    const al = Math.cos(angleDelta(s.position.heading, junctionPlayer.heading));
    return rel.forward > 18 && rel.forward < 30 && Math.abs(al) > 0.65 && Math.abs(rel.right) < 7.5;
  });
  assert.ok(forwardLaneSlot && forwardLaneSlot.score >= junctionPick.score + 65, "same-corridor forward slot must carry >=65 penalty on opening");

  // Safety berth negative control: head-on / front-bumper slots within 16.5m on opening are strictly Infinity
  const bumperSlot = {
    lane: lanes[0],
    position: {
      x: player.x + Math.sin(player.heading) * 12,
      z: player.z + Math.cos(player.heading) * 12,
      heading: player.heading + Math.PI,
    },
    score: 0,
  };
  const crossSafeSlot = {
    lane: lanes[0],
    position: {
      x: player.x - 21.3,
      z: player.z - 6.9,
      heading: Math.PI,
    },
    score: 0,
  };
  const checked = scoreAggressiveDeploymentSlots(
    world,
    makeAggressiveState(),
    placed[0].car,
    player,
    [bumperSlot, crossSafeSlot],
    "intercept",
    true,
  );
  assert.equal(bumperSlot.score, Infinity, "bumper-overlap berth (<16.5m, |right|<2.6) must be rejected on opening");
  assert.equal(checked[0], crossSafeSlot);

  // Mid-chase (opening === false) reinforcement: bounds 26..58m, intercepts ahead
  const midBounds = aggressiveDeploymentBounds(makeAggressiveState(), false);
  assert.deepEqual(midBounds, { minRange: 26, maxRange: 58 });
  const midSlots = scoreAggressiveDeploymentSlots(
    world,
    makeAggressiveState(),
    { ...probeCar, gtaAI: { order: 0 } },
    player,
    candidateSlots(lanes, player, midBounds.minRange, midBounds.maxRange),
    "intercept",
    false,
    true,
  );
  assert.ok(midSlots.filter((s) => Number.isFinite(s.score)).every((s) => gtaLocal(player, s.position).forward > 2));
  const midPick = midSlots[0];
  const midRel = gtaLocal(player, midPick.position);
  const midRange = distance(player, midPick.position);
  assert.ok(midRel.forward >= 20 && midRel.forward <= 50, `expected mid-chase intercept forward in [20,50], got ${midRel.forward}`);
  assert.ok(midRange >= 26 && midRange <= 58, `expected mid-chase intercept range in 26..58m, got ${midRange}`);

  // Backup 20m spacing penalty check when opening && count >= 2
  const backupSpacingState = makeAggressiveState({
    patrols: new Set([{ x: -278, z: -70 }, { x: -278, z: -50 }]),
  });
  const crowdedBackupSlot = { lane: lanes[0], position: { x: -278, z: -65, heading: Math.PI }, score: 0 }; // 5m from (-278,-70)
  const clearBackupSlot = { lane: lanes[0], position: { x: -220, z: -75, heading: Math.PI }, score: 0 }; // >20m from both
  scoreAggressiveDeploymentSlots(
    world,
    backupSpacingState,
    { gtaAI: { order: 2 } },
    player,
    [crowdedBackupSlot, clearBackupSlot],
    "flank",
    true,
  );
  assert.ok(clearBackupSlot.score < crowdedBackupSlot.score, "20m backup spacing penalty spreads units >= 2");
});

test("aggressiveInitialSpeed and aggressivePatrolPace scale with wanted level and respect level caps up to car.maxSpeed", () => {
  const cruiser = { maxSpeed: 31.6 };
  const openLv1 = aggressiveInitialSpeed(cruiser, true, 1);
  const openLv5 = aggressiveInitialSpeed(cruiser, true, 5);
  const reinfLv1 = aggressiveInitialSpeed(cruiser, false, 1);
  const reinfLv5 = aggressiveInitialSpeed(cruiser, false, 5);

  assert.equal(openLv1, 5.25);
  assert.equal(openLv5, 8.25);
  assert.equal(reinfLv1, 7.75);
  assert.equal(reinfLv5, 10.75);
  assert.ok(openLv5 > openLv1 && reinfLv1 > openLv1 && reinfLv5 > reinfLv1);
  assert.equal(aggressiveInitialSpeed({ maxSpeed: 9 }, false, 5), 9);

  const pursuitLv1 = makeAggressiveState({ wantedLevel: 1 });
  const pursuitLv3 = makeAggressiveState({ wantedLevel: 3 });
  const pursuitLv5 = makeAggressiveState({ wantedLevel: 5 });
  const paceLv1 = aggressivePatrolPace(pursuitLv1, cruiser, 10, 20);
  const paceLv3 = aggressivePatrolPace(pursuitLv3, cruiser, 10, 20);
  const paceLv5 = aggressivePatrolPace(pursuitLv5, cruiser, 10, 20);
  assert.ok(paceLv5 > paceLv3 && paceLv3 > paceLv1, `expected pace scaling Lv5 (${paceLv5}) > Lv3 (${paceLv3}) > Lv1 (${paceLv1})`);
  assert.ok(paceLv1 >= 8.5 && paceLv5 <= cruiser.maxSpeed);

  // High reportSpeed + range respects wanted-level caps [17.5, 19.5, 21.5, 23.0, 24.8] and car.maxSpeed
  assert.equal(aggressivePatrolPace(pursuitLv1, cruiser, 30, 50), 17.5);
  assert.equal(aggressivePatrolPace(makeAggressiveState({ wantedLevel: 2 }), cruiser, 30, 50), 19.5);
  assert.equal(aggressivePatrolPace(pursuitLv3, cruiser, 30, 50), 21.5);
  assert.equal(aggressivePatrolPace(makeAggressiveState({ wantedLevel: 4 }), cruiser, 30, 50), 23.0);
  assert.equal(aggressivePatrolPace(pursuitLv5, cruiser, 30, 50), 24.8);
  assert.equal(aggressivePatrolPace(pursuitLv5, { maxSpeed: 16 }, 30, 50), 16);

  // Multiplier scales pace before capping at levelCap / car.maxSpeed
  const boosted = makeAggressiveState({
    wantedLevel: 3,
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, npcSpeedMultiplier: 1.15 } },
  });
  assert.ok(aggressivePatrolPace(boosted, cruiser, 8, 15) > aggressivePatrolPace(pursuitLv3, cruiser, 8, 15));
});

test("recycleTrailingChasePatrols recycles under ZONE_TRACKED when gap > 82 for 150 ticks and returns 0 under VISUALLY_SPOTTED, LOST, and SEARCHING", () => {
  const world = new World({ cityVersion: 4, traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false },
  });
  world.pursuit.gta.config = Object.freeze({
    ...world.pursuit.gta.config,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  });

  // Place player further east so -90m behind is well behind along tahrir-boulevard (gap = 90 > 82)
  world.player.x = -165;
  world.player.z = -109.3;
  world.player.heading = Math.PI / 2;

  const trailingPatrol = world.makeVehicle("trailing-1", "sedan", {
    x: -255, // 90m behind player (gap = 90 > 82, forward = -90 < -14)
    z: -109.3,
    heading: Math.PI / 2,
  });
  trailingPatrol.unitType = "interceptor";
  trailingPatrol.aiState = "PURSUIT";
  trailingPatrol.speed = 12;
  trailingPatrol.previous = { x: -255.2, z: -109.3, heading: Math.PI / 2 };
  trailingPatrol.gtaAI = { order: 0, chaseFarTicks: 149, chaseStallTicks: 0, nextAggressiveRecycle: 0 };

  const roadblockCar = world.makeVehicle("roadblock-1", "sedan", {
    x: -260,
    z: -109.3,
    heading: Math.PI / 2,
  });
  roadblockCar.unitType = "patrol";
  roadblockCar.aiState = "ROADBLOCK";
  roadblockCar.gtaAI = { order: 1, chaseFarTicks: 199, chaseStallTicks: 0, nextAggressiveRecycle: 0 };

  world.pursuit.patrols.add(trailingPatrol);
  world.pursuit.patrols.add(roadblockCar);

  // NEGATIVE CONTROLS: VISUALLY_SPOTTED, SEARCHING, and LOST must all return 0, reset counters, and never redeploy
  let deployCalls = [];
  let removed = [];
  for (const stateName of ["VISUALLY_SPOTTED", "SEARCHING", "LOST"]) {
    trailingPatrol.gtaAI.chaseFarTicks = 160;
    trailingPatrol.gtaAI.chaseStallTicks = 190;
    world.pursuit.response.dispatch.state = stateName;
    assert.equal(
      recycleTrailingChasePatrols(
        world,
        (...args) => {
          deployCalls.push(args);
          return { id: "should-not-spawn" };
        },
        (car) => removed.push(car),
      ),
      0,
      `dispatch state ${stateName} must refuse to recycle patrols`,
    );
    assert.equal(deployCalls.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(trailingPatrol.gtaAI.chaseFarTicks, 0, `${stateName} must reset chaseFarTicks`);
    assert.equal(trailingPatrol.gtaAI.chaseStallTicks, 0, `${stateName} must reset chaseStallTicks`);
  }

  // Under ZONE_TRACKED, gap <= 82 (e.g. 75m) does NOT accumulate chaseFarTicks
  world.pursuit.response.dispatch.state = "ZONE_TRACKED";
  trailingPatrol.x = -240; // gap = 75 <= 82
  trailingPatrol.gtaAI.chaseFarTicks = 10;
  assert.equal(recycleTrailingChasePatrols(world, () => ({ id: "no" }), () => {}), 0);
  assert.equal(trailingPatrol.gtaAI.chaseFarTicks, 0, "gap <= 82m must reset chaseFarTicks");

  // POSITIVE CASE: ZONE_TRACKED with gap = 90 > 82 accumulates 150 far ticks and recycles via flank -> tail
  trailingPatrol.x = -255; // gap = 90 > 82
  world.tick = 200;
  for (let i = 0; i < 149; i++) {
    assert.equal(
      recycleTrailingChasePatrols(
        world,
        () => ({ id: "early" }),
        (car) => removed.push(car),
      ),
      0,
    );
  }
  assert.equal(trailingPatrol.gtaAI.chaseFarTicks, 149);

  // 150th tick triggers recycling: tries ("flank", unitType, false) then falls back to ("tail", unitType, false)
  const replacement = { id: "recycled-street" };
  const recycledCount = recycleTrailingChasePatrols(
    world,
    (tactic, unitType, forwardOnly) => {
      deployCalls.push([tactic, unitType, forwardOnly]);
      return tactic === "tail" ? replacement : null;
    },
    (car) => {
      removed.push(car);
      world.pursuit.patrols.delete(car);
    },
  );
  assert.equal(recycledCount, 1);
  assert.deepEqual(deployCalls, [
    ["flank", "interceptor", false],
    ["tail", "interceptor", false],
  ]);
  assert.deepEqual(removed, [trailingPatrol]);
  assert.equal(trailingPatrol.gtaAI.nextAggressiveRecycle, 350);
  assert.equal(world.pursuit.patrols.has(roadblockCar), true, "stationary ROADBLOCK unit must not be recycled");
});

test("recycleTrailingChasePatrols recycles stalled patrols at 180 ticks under ZONE_TRACKED and caps recyclings at 1 per tick with 150-tick cooldown", () => {
  const world = new World({ cityVersion: 4, traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false },
  });
  world.pursuit.gta.config = Object.freeze({
    ...world.pursuit.gta.config,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  });
  world.pursuit.response.dispatch.state = "ZONE_TRACKED";
  world.tick = 500;

  const makeStalled = (id, offset) => ({
    id,
    x: world.player.x + 35 + offset,
    z: world.player.z + 5.4,
    heading: world.player.heading,
    speed: 0.2,
    unitType: "patrol",
    aiState: "PURSUIT",
    previous: { x: world.player.x + 35 + offset + 0.01, z: world.player.z + 5.4, heading: world.player.heading },
    gtaAI: { chaseFarTicks: 0, chaseStallTicks: 179, nextAggressiveRecycle: 0 },
  });

  const s1 = makeStalled("stalled-1", 0);
  const s2 = makeStalled("stalled-2", 4);
  world.pursuit.patrols.add(s1);
  world.pursuit.patrols.add(s2);

  const removed = [];
  const count = recycleTrailingChasePatrols(
    world,
    () => ({ id: "fresh" }),
    (car) => removed.push(car.id),
  );
  assert.equal(count, 1, "must cap aggressive recyclings at 1 per tick");
  assert.deepEqual(removed, ["stalled-1"]);
  assert.equal(s2.gtaAI.chaseStallTicks, 180, "remaining patrol still tracks stall ticks for next tick");

  // Cooldown & null-replacement guard: keeps existing patrol when deployPatrol returns null and waits 150 ticks
  world.pursuit.patrols.clear();
  world.pursuit.patrols.add(s2);
  let attempts = 0;
  assert.equal(
    recycleTrailingChasePatrols(
      world,
      () => {
        attempts++;
        return null;
      },
      (car) => removed.push(car.id),
    ),
    0,
  );
  assert.equal(attempts, 2, "tries flank then tail once before entering 150-tick cooldown");
  assert.equal(s2.gtaAI.nextAggressiveRecycle, 650);
  world.tick = 649;
  assert.equal(
    recycleTrailingChasePatrols(world, () => ({ id: "blocked-by-cooldown" }), (car) => removed.push(car.id)),
    0,
  );

  // Guards for non-running phase and non-aggressive config
  world.tick = 700;
  world.pursuit.phase = "escaped";
  assert.equal(recycleTrailingChasePatrols(world, () => ({ id: "no" }), () => {}), 0);
  world.pursuit.phase = "running";
  world.pursuit.gta.config = Object.freeze({ ...world.pursuit.gta.config, chasePresence: undefined });
  assert.equal(recycleTrailingChasePatrols(world, () => ({ id: "no" }), () => {}), 0);
});
