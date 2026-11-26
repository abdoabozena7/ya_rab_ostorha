import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";
import { STEP } from "../src/core/config.js";
import { createVehicleState, advanceVehicleState } from "../src/core/vehicle-state.js";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import { createCrashEffects } from "../src/render/crash-effects.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/car-crash-parts-20261123/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function computeRigSnapshotHash(root) {
  root.updateMatrixWorld(true);
  const hash = createHash("sha256");
  const invRoot = root.matrixWorld.clone().invert();
  const entries = [];
  root.traverse((node) => {
    if (!node.isMesh && !node.isLineSegments) return;
    const rel = invRoot.clone().multiply(node.matrixWorld);
    const posAttr = node.geometry?.getAttribute?.("position");
    const bufHash = createHash("sha256");
    if (posAttr?.array) {
      bufHash.update(Buffer.from(posAttr.array.buffer, posAttr.array.byteOffset, posAttr.array.byteLength));
    }
    let visibleChain = true;
    for (let cur = node; cur; cur = cur.parent) {
      if (!cur.visible) { visibleChain = false; break; }
      if (cur === root) break;
    }
    entries.push({
      name: node.name || node.type,
      visible: visibleChain,
      matrix: rel.elements.map((v) => Number(v.toFixed(6))),
      buf: bufHash.digest("hex"),
    });
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  hash.update(JSON.stringify(entries));
  return hash.digest("hex");
}

function runNegativeFaultOracle() {
  // 1. Fault A: Non-contact phantom part breakage during normal driving
  const beforeClean = { x: 0, z: 0, heading: 0, speed: 11.8, steer: 0.08, vehicle: createVehicleState() };
  const afterClean = { x: 0, z: 0.2, heading: 0, speed: 12.0, steer: 0.08 };
  const cleanVehicle = advanceVehicleState(beforeClean, afterClean, { throttle: 0.4, brake: 0 }, STEP, { tick: 1 });
  const faultyPhantomState = structuredClone(cleanVehicle);
  faultyPhantomState.damage.parts.hood.state = "buckled";
  faultyPhantomState.damage.brokenCount = 1;
  const detectedPhantomBreakageFault =
    cleanVehicle.damage.brokenCount === 0 &&
    faultyPhantomState.damage.brokenCount > 0 &&
    faultyPhantomState.damage.parts.hood.state !== "intact";

  // 2. Fault B: Stationary held-contact duplicate debris burst spam
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const mockWorld = {
    tick: 10,
    player: {
      x: 0, y: 0, z: 0, heading: 0, speed: 0, width: 1.9, length: 4.2,
      vehicle: createVehicleState(),
    },
    actors: [],
  };
  mockWorld.player.vehicle.damage.front = 0.55;
  mockWorld.player.vehicle.damage.total = 0.35;
  mockWorld.player.vehicle.damage.impactCount = 1;
  mockWorld.player.vehicle.damage.lastImpact = {
    tick: 10, side: "front", closingSpeedMps: 11, energyJ: 52000,
    brokenParts: ["hood", "frontBumper"], detachedParts: ["frontBumper"], shatteredGlass: true,
  };
  fx.update(mockWorld, STEP);
  const realBurstsAfterFirst = fx.diagnostics().totalBurstsSpawned;
  for (let i = 0; i < 15; i++) {
    mockWorld.tick++;
    fx.update(mockWorld, STEP);
  }
  const realHeldBursts = fx.diagnostics().totalBurstsSpawned;
  // Inject faulty duplicate held-contact spam (what happens if burst latch is bypassed)
  let faultyHeldBursts = realBurstsAfterFirst;
  for (let i = 0; i < 5; i++) {
    fx.spawnBurst({ x: 0, z: 0, side: "front", energyJ: 24000, owner: "player" });
    faultyHeldBursts = fx.diagnostics().totalBurstsSpawned;
  }
  fx.dispose();
  const detectedDuplicateHeldBurstFault =
    realBurstsAfterFirst === 1 &&
    realHeldBursts === 1 &&
    faultyHeldBursts > 1;

  // 3. Fault C: Incomplete repair leaving residual part rotation or detached state
  const actor = { id: "player", x: 0, z: 0, heading: 0, speed: 0, steer: 0, width: 1.9, length: 4.2, vehicle: createVehicleState() };
  const rig = createPlayerVehicle(null, actor);
  rig.update(actor);
  const pristineHash = computeRigSnapshotHash(rig.root);

  // Crash heavily
  actor.vehicle = advanceVehicleState(
    { ...actor, speed: 15 },
    { ...actor, speed: 1.5 },
    { throttle: 0, brake: 0 },
    STEP,
    {
      tick: 5,
      contact: {
        hitId: "test-barrier",
        side: "front",
        closingSpeedMps: 15,
        proposedTravelM: 0.25,
        normal: { x: 0, z: -1 },
        otherX: 0.35,
        otherZ: 2.2,
      },
    },
  );
  rig.update(actor);
  const crashedHash = computeRigSnapshotHash(rig.root);

  // Real repair
  actor.vehicle = createVehicleState();
  rig.update(actor);
  const repairedHash = computeRigSnapshotHash(rig.root);

  // Faulty incomplete repair (leaving hood slightly buckled & left mirror detached)
  const hoodPivot = rig.root.getObjectByName("suv-hood-pivot");
  const leftMirror = rig.root.getObjectByName("suv-mirror-left");
  if (hoodPivot) hoodPivot.rotation.x = -0.24;
  if (leftMirror) leftMirror.visible = false;
  const faultyRepairHash = computeRigSnapshotHash(rig.root);
  rig.dispose();

  const detectedIncompleteRepairFault =
    pristineHash !== crashedHash &&
    repairedHash === pristineHash &&
    faultyRepairHash !== pristineHash;

  const report = {
    passed: !(detectedPhantomBreakageFault && detectedDuplicateHeldBurstFault && detectedIncompleteRepairFault),
    detectedPhantomBreakageFault,
    detectedDuplicateHeldBurstFault,
    detectedIncompleteRepairFault,
    details: {
      realBurstsAfterFirst,
      realHeldBursts,
      faultyHeldBursts,
      pristineHash,
      crashedHash,
      repairedHash,
      faultyRepairHash,
      pristineMatchedRealRepair: repairedHash === pristineHash,
      faultyRepairMismatchDetected: faultyRepairHash !== pristineHash,
    },
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(report, null, 2));
  console.log("Negative control faults verified:", JSON.stringify(report));
  process.exit(report.passed ? 0 : 1);
}

if (negativeFaultMode) {
  runNegativeFaultOracle();
}

function auditSuvDetails() {
  const actor = { id: "player", x: 0, z: 0, heading: 0, speed: 0, steer: 0, width: 1.9, length: 4.2, vehicle: createVehicleState() };
  const rig = createPlayerVehicle(null, actor);
  rig.update(actor);
  rig.root.updateMatrixWorld(true);

  const requiredNames = [
    "suv-radiator-core",
    "suv-crash-bar",
    "suv-battery-box",
    "suv-coolant-hose",
    "suv-tow-hook-left",
    "suv-tow-hook-right",
    "suv-front-plate",
    "suv-rear-plate",
    "suv-chmsl",
    "suv-exhaust-left",
    "suv-exhaust-right",
    "suv-muffler",
    "suv-hood-pivot",
    "suv-windshield-cracks",
    "suv-rear-window-cracks",
  ];
  const found = {};
  for (const name of requiredNames) {
    found[name] = Boolean(rig.root.getObjectByName(name));
  }

  let meshCount = 0;
  rig.root.traverse((n) => { if (n.isMesh) meshCount++; });

  // Verify front and rear RGB cameras are unobstructed by new meshes
  const raycaster = new THREE.Raycaster();
  const checkCameraClear = (camName, forwardSign) => {
    const camNode = rig.root.getObjectByName(camName);
    if (!camNode) return true;
    const origin = camNode.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, forwardSign).applyQuaternion(rig.root.quaternion).normalize();
    raycaster.set(origin.clone().addScaledVector(dir, 0.08), dir);
    raycaster.far = 2.5;
    const hits = raycaster.intersectObjects(rig.root.children, true)
      .filter((h) => h.object.visible && !/glass|windshield|window|camera|sensor/i.test(h.object.name));
    return hits.length === 0;
  };
  const frontCameraClear = checkCameraClear("sensor-camera-front", 1);
  const rearCameraClear = checkCameraClear("sensor-camera-rear", -1);

  // Verify cracks hidden when pristine
  const wsCracks = rig.root.getObjectByName("suv-windshield-cracks");
  const rwCracks = rig.root.getObjectByName("suv-rear-window-cracks");
  const cracksHiddenPristine = wsCracks?.visible === false && rwCracks?.visible === false;

  rig.dispose();
  const allFound = Object.values(found).every(Boolean);
  return {
    passed: allFound && meshCount >= 65 && frontCameraClear && rearCameraClear && cracksHiddenPristine,
    meshCount,
    found,
    frontCameraClear,
    rearCameraClear,
    cracksHiddenPristine,
  };
}

function runHeavyBayCrashAndRepairTrial() {
  const world = new World({ seed: "heavy-crash-bay-01" }, "vehicle");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  view.sync(1);
  const rig = view.playerRig;
  const pristineHash = computeRigSnapshotHash(rig.root);

  const started = world.command({ type: "vehicle-test", operation: "run", heavy: true });
  assert.equal(started, true, "Heavy vehicle-test run must start");

  let peakBrokenCount = 0;
  let peakDebris = 0;
  let peakSparks = 0;
  let peakGlass = 0;
  let peakSmoke = 0;
  for (let tick = 0; tick < 180; tick++) {
    world.step(STEP);
    view.sync(1);
    const dmg = world.player.vehicle.damage;
    peakBrokenCount = Math.max(peakBrokenCount, dmg.brokenCount ?? 0);
    const fxDiag = view.crashDiagnostics();
    if (fxDiag) {
      peakDebris = Math.max(peakDebris, fxDiag.activeDebrisParts);
      peakSparks = Math.max(peakSparks, fxDiag.activeSparks);
      peakGlass = Math.max(peakGlass, fxDiag.activeGlassShards);
      peakSmoke = Math.max(peakSmoke, fxDiag.activeSmokePuffs);
    }
  }

  const crashedPhase = world.vehicleTest.phase;
  const crashedDamage = structuredClone(world.player.vehicle.damage);
  const crashedRigDiag = structuredClone(rig.diagnostics.damage);
  const hoodPivot = rig.root.getObjectByName("suv-hood-pivot");
  const hoodBuckledAngleRad = hoodPivot ? Math.abs(hoodPivot.rotation.x) : 0;
  const wsCracksVisible = Boolean(rig.root.getObjectByName("suv-windshield-cracks")?.visible);
  const crashedHash = computeRigSnapshotHash(rig.root);

  // Now reset / repair in the bay and verify byte-for-byte pristine parity!
  const resetOk = world.command({ type: "vehicle-test", operation: "reset" });
  assert.equal(resetOk, true, "Vehicle test reset must succeed");
  view.sync(1);
  const repairedHash = computeRigSnapshotHash(rig.root);
  const fxAfterRepair = view.crashDiagnostics();
  const exactRepairParity =
    repairedHash === pristineHash &&
    pristineHash !== crashedHash &&
    world.player.vehicle.damage.brokenCount === 0 &&
    rig.diagnostics.damage.brokenParts.length === 0 &&
    (fxAfterRepair?.activeDebrisParts ?? 0) === 0;

  view.dispose();
  return {
    heavyBayCrashTrial: {
      passed:
        crashedPhase === "contact" &&
        crashedDamage.front >= 0.45 &&
        peakBrokenCount >= 4 &&
        crashedRigDiag.brokenParts.length >= 3 &&
        (hoodBuckledAngleRad > 0.08 || (crashedRigDiag.detachedParts.includes("hood") && crashedRigDiag.radiatorExposed === true)) &&
        wsCracksVisible &&
        peakDebris >= 2 &&
        peakSparks >= 6 &&
        peakSmoke >= 1,
      crashedPhase,
      impactSpeedMps: Number((crashedDamage.lastImpact?.closingSpeedMps ?? 0).toFixed(2)),
      frontDamage: Number(crashedDamage.front.toFixed(3)),
      brokenCount: crashedDamage.brokenCount,
      detachedCount: crashedDamage.detachedCount,
      rigBrokenParts: crashedRigDiag.brokenParts,
      rigDetachedParts: crashedRigDiag.detachedParts,
      hoodBuckledAngleRad: Number(hoodBuckledAngleRad.toFixed(4)),
      windshieldCracksVisible: wsCracksVisible,
      peakDebris,
      peakSparks,
      peakGlass,
      peakSmoke,
    },
    exactRepairParity,
  };
}

function runAsymmetricPartBreakageTrial() {
  // 1. Front-left corner impact: left headlamp breaks more than right headlamp; front-skid center flange stays bolted!
  const actorFL = { id: "player", x: 0, z: 0, heading: 0, speed: 12.5, steer: 0, width: 1.9, length: 4.2, vehicle: createVehicleState() };
  const rigFL = createPlayerVehicle(null, actorFL);
  rigFL.update(actorFL);
  const skidCenterBefore = rigFL.root.getObjectByName("suv-front-skid")?.position.clone();
  actorFL.vehicle = advanceVehicleState(
    { ...actorFL, speed: 12.5 },
    { ...actorFL, speed: 1.5 },
    { throttle: 0, brake: 0 },
    STEP,
    {
      tick: 12,
      contact: {
        hitId: "corner-pillar",
        side: "front",
        closingSpeedMps: 7.2,
        proposedTravelM: 0.18,
        normal: { x: 0.25, z: -0.968 },
        otherX: -0.78,
        otherZ: 2.05,
      },
    },
  );
  actorFL.speed = 1.5;
  rigFL.update(actorFL);
  const hlLeftDmg = actorFL.vehicle.damage.parts.headlampLeft.damage;
  const hlRightDmg = actorFL.vehicle.damage.parts.headlampRight.damage;
  const hoodBuckledRad = Math.abs(rigFL.root.getObjectByName("suv-hood-pivot")?.rotation?.x ?? 0);
  const skidCenterAfter = rigFL.root.getObjectByName("suv-front-skid")?.position.clone();
  const skidPinned = Boolean(skidCenterBefore && skidCenterAfter && skidCenterBefore.distanceTo(skidCenterAfter) < 0.02);
  rigFL.dispose();

  // 2. Left-side T-bone impact: left mirror dangles/detaches & left door pops ajar while right mirror stays intact!
  const actorSide = { id: "player", x: 0, z: 0, heading: 0, speed: 3, steer: 0, width: 1.9, length: 4.2, vehicle: createVehicleState() };
  const rigSide = createPlayerVehicle(null, actorSide);
  actorSide.vehicle = advanceVehicleState(
    { ...actorSide, speed: 3 },
    { ...actorSide, speed: 1 },
    { throttle: 0, brake: 0 },
    STEP,
    {
      tick: 20,
      contact: {
        hitId: "side-cruiser",
        side: "left",
        closingSpeedMps: 13.0,
        proposedTravelM: 0.2,
        normal: { x: 1, z: 0 },
        otherX: -1.6,
        otherZ: 0.35,
      },
    },
  );
  rigSide.update(actorSide);
  const leftMirrorBroken = actorSide.vehicle.damage.parts.mirrorLeft.state !== "intact";
  const rightMirrorIntact = actorSide.vehicle.damage.parts.mirrorRight.state === "intact";
  const leftDoorDamaged = actorSide.vehicle.damage.parts.doorLeft.damage > 0.25;
  const leftDoorAjarRad = rigSide.root.getObjectByName("suv-left-door-pivot")?.rotation?.y ?? 0;
  const rightDoorAjarRad = rigSide.root.getObjectByName("suv-right-door-pivot")?.rotation?.y ?? 0;
  rigSide.dispose();

  // 3. Rear impact: spare carrier tilts/detaches, rear bumper & exhaust deform, front hood stays intact!
  const actorRear = { id: "player", x: 0, z: 0, heading: 0, speed: 1, steer: 0, width: 1.9, length: 4.2, vehicle: createVehicleState() };
  const rigRear = createPlayerVehicle(null, actorRear);
  actorRear.vehicle = advanceVehicleState(
    { ...actorRear, speed: 1 },
    { ...actorRear, speed: 5 },
    { throttle: 0, brake: 0 },
    STEP,
    {
      tick: 30,
      contact: {
        hitId: "rear-cruiser",
        side: "rear",
        closingSpeedMps: 13.5,
        proposedTravelM: 0.2,
        normal: { x: 0, z: 1 },
        otherX: 0.22,
        otherZ: -2.35,
      },
    },
  );
  rigRear.update(actorRear);
  const spareBroken = actorRear.vehicle.damage.parts.spareCarrier.state !== "intact";
  const rearBumperBroken = actorRear.vehicle.damage.parts.rearBumper.damage > 0.3;
  const hoodStillIntact = actorRear.vehicle.damage.parts.hood.state === "intact";
  rigRear.dispose();

  return {
    passed:
      hlLeftDmg > hlRightDmg + 0.15 &&
      hoodBuckledRad > 0.05 &&
      skidPinned &&
      leftMirrorBroken &&
      rightMirrorIntact &&
      leftDoorDamaged &&
      leftDoorAjarRad > 0.1 &&
      Math.abs(rightDoorAjarRad) < 1e-6 &&
      spareBroken &&
      rearBumperBroken &&
      hoodStillIntact,
    frontLeftAsymmetry: {
      headlampLeftDamage: Number(hlLeftDmg.toFixed(3)),
      headlampRightDamage: Number(hlRightDmg.toFixed(3)),
      hoodBuckledRad: Number(hoodBuckledRad.toFixed(4)),
      skidPinned,
    },
    leftSideImpact: {
      mirrorLeftState: actorSide.vehicle.damage.parts.mirrorLeft.state,
      mirrorRightState: actorSide.vehicle.damage.parts.mirrorRight.state,
      doorLeftState: actorSide.vehicle.damage.parts.doorLeft.state,
      leftDoorAjarRad: Number(leftDoorAjarRad.toFixed(4)),
    },
    rearImpact: {
      spareCarrierState: actorRear.vehicle.damage.parts.spareCarrier.state,
      rearBumperDamage: Number(actorRear.vehicle.damage.parts.rearBumper.damage.toFixed(3)),
      hoodState: actorRear.vehicle.damage.parts.hood.state,
    },
  };
}

function runDebrisAndSmokeTrial() {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const mockWorld = {
    tick: 1,
    player: {
      x: 10, y: 0, z: 20, heading: 0.3, speed: 8, width: 1.9, length: 4.2,
      vehicle: createVehicleState(),
    },
    actors: [],
  };
  mockWorld.player.vehicle.damage.front = 0.78;
  mockWorld.player.vehicle.damage.total = 0.52;
  mockWorld.player.vehicle.damage.impactCount = 1;
  mockWorld.player.vehicle.damage.parts.radiator.leaking = true;
  mockWorld.player.vehicle.damage.lastImpact = {
    tick: 1,
    side: "front",
    closingSpeedMps: 14.2,
    energyJ: 82000,
    brokenParts: ["hood", "frontBumper", "grille", "headlampLeft", "windshield"],
    detachedParts: ["frontBumper", "mirrorLeft", "grille"],
    shatteredGlass: true,
  };

  fx.update(mockWorld, STEP);
  const initialDiag = fx.diagnostics();
  const activeDebrisMeshes = [];
  fx.layer.traverse((n) => {
    if (n.isMesh && n.name.startsWith("crash-debris-part-") && n.visible) {
      activeDebrisMeshes.push({ name: n.name, y0: n.position.y, rot0: n.rotation.x });
    }
  });

  // Advance 30 ticks of stationary held contact (same impactCount=1, same lastImpact.tick=1)
  let settledOnGroundCount = 0;
  let maxSmokePuffs = initialDiag.activeSmokePuffs;
  for (let i = 0; i < 45; i++) {
    mockWorld.tick++;
    mockWorld.player.speed = 0;
    fx.update(mockWorld, 1 / 30);
    maxSmokePuffs = Math.max(maxSmokePuffs, fx.diagnostics().activeSmokePuffs);
  }
  fx.layer.traverse((n) => {
    if (n.isMesh && n.name.startsWith("crash-debris-part-") && n.visible && n.position.y <= 0.16) {
      settledOnGroundCount++;
    }
  });
  const afterDiag = fx.diagnostics();
  fx.dispose();

  return {
    passed:
      initialDiag.totalBurstsSpawned === 1 &&
      afterDiag.totalBurstsSpawned === 1 &&
      !initialDiag.spawnedPartKinds.includes("hood-panel") &&
      initialDiag.activeDebrisParts >= 2 &&
      initialDiag.activeGlassShards >= 8 &&
      initialDiag.activeSparks >= 10 &&
      maxSmokePuffs >= 3 &&
      settledOnGroundCount >= 1,
    noDuplicateAttachedHood: !initialDiag.spawnedPartKinds.includes("hood-panel"),
    initialDiag,
    afterHeldTicksBursts: afterDiag.totalBurstsSpawned,
    maxSmokePuffs,
    settledOnGroundCount,
  };
}

function runPoliceCruiserCrashTrial() {
  const world = new World({ cityVersion: 5, seed: "cruiser-crash-eval-01", traffic: 8, pedestrians: 6 }, "metro");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  const started = world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 5,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
      tacticalPursuit: TACTICAL_PURSUIT_MODE,
      patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
      patrolChainYield: PATROL_LATERAL_YIELD,
      wantedLevelMax: 5,
      maxActivePatrols: 8,
    },
  }, false);
  assert.equal(started, true, "Metro pursuit must start");

  for (let i = 0; i < 8; i++) world.step(STEP);
  const patrols = [...world.pursuit.patrols];
  assert.ok(patrols.length >= 1, "At least one patrol unit must spawn");
  const cruiser = patrols[0];
  const civCar = world.actors.find((a) => a.type === "vehicle" && a !== world.player && !world.pursuit.patrols.has(a));

  // Stage direct high-speed collision between cruiser and player SUV on the road
  const ego = world.player;
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  ego.speed = 11;
  world.input = { targetSpeed: 12, steer: 0 };
  cruiser.x = ego.x + sin * 4.55;
  cruiser.z = ego.z + cos * 4.55;
  cruiser.heading = ego.heading + Math.PI;
  cruiser.speed = 18;
  cruiser.vx = Math.sin(cruiser.heading) * cruiser.speed;
  cruiser.vz = Math.cos(cruiser.heading) * cruiser.speed;

  let sawCrumpledPatrol = false;
  let sawCrumpledCivilian = false;
  let peakSmoke = 0;
  let peakBursts = 0;
  for (let i = 0; i < 20; i++) {
    if (i === 7 && civCar) {
      // Clear wrecked cruiser aside on road and stage direct road collision with civilian car
      const sNow = Math.sin(ego.heading), cNow = Math.cos(ego.heading);
      cruiser.x = ego.x - sNow * 14;
      cruiser.z = ego.z - cNow * 14;
      cruiser.speed = 0;
      cruiser.vx = 0;
      cruiser.vz = 0;
      ego.speed = 12;
      world.input = { targetSpeed: 14, steer: 0 };
      civCar.x = ego.x + sNow * 4.55;
      civCar.z = ego.z + cNow * 4.55;
      civCar.heading = ego.heading + Math.PI;
      civCar.speed = 0;
    }
    world.step(STEP);
    if (i === 5 && cruiser.aiState !== "WRECKED") {
      // Also test full cruiser wreck state (tilted lightbar + wrecked crumple + dark smoke)
      cruiser.health = 0;
      cruiser.aiState = "WRECKED";
    }
    view.sync(1);
    view.prepareFrame();
    const pDiag = view.pursuitDiagnostics();
    const cDiag = view.crashDiagnostics();
    if ((pDiag?.crumpledPatrols ?? 0) >= 1) sawCrumpledPatrol = true;
    if (civCar) {
      const civShell = view.roots.get(civCar.id)?.visual?.getObjectByName("traffic-shell");
      if (civShell?.userData?.damagedGeometry) sawCrumpledCivilian = true;
    }
    peakSmoke = Math.max(peakSmoke, cDiag?.activeSmokePuffs ?? 0);
    peakBursts = Math.max(peakBursts, cDiag?.totalBurstsSpawned ?? 0);
  }

  // Stop pursuit and ensure pooled traffic models clean up without throwing
  if (world.pursuit?.phase === "running") {
    world.command({ type: "street-pursuit-stop" }, false);
  }
  view.sync(1);
  view.prepareFrame();
  view.dispose();

  return {
    passed: sawCrumpledPatrol && sawCrumpledCivilian && peakBursts >= 1 && peakSmoke >= 1 && world.player.vehicle.damage.total > 0,
    sawCrumpledPatrol,
    sawCrumpledCivilian,
    peakBursts,
    peakSmoke,
    playerDamageTotal: Number(world.player.vehicle.damage.total.toFixed(3)),
    playerBrokenCount: world.player.vehicle.damage.brokenCount,
  };
}

const suvDetailsAudit = auditSuvDetails();
const { heavyBayCrashTrial, exactRepairParity } = runHeavyBayCrashAndRepairTrial();
const asymmetricPartBreakageTrial = runAsymmetricPartBreakageTrial();
const debrisAndSmokeTrial = runDebrisAndSmokeTrial();
const policeCruiserCrashTrial = runPoliceCruiserCrashTrial();

const report = {
  passed:
    suvDetailsAudit.passed &&
    heavyBayCrashTrial.passed &&
    asymmetricPartBreakageTrial.passed &&
    debrisAndSmokeTrial.passed &&
    policeCruiserCrashTrial.passed &&
    exactRepairParity,
  suvDetailsAudit,
  heavyBayCrashTrial,
  asymmetricPartBreakageTrial,
  debrisAndSmokeTrial,
  policeCruiserCrashTrial,
  exactRepairParity,
};

writeFileSync(join(outDir, "car-crash-eval.json"), JSON.stringify(report, null, 2));
console.log("Car crash & authored details evaluation:", JSON.stringify({
  passed: report.passed,
  suvDetailsPassed: suvDetailsAudit.passed,
  heavyBayPassed: heavyBayCrashTrial.passed,
  asymmetricPassed: asymmetricPartBreakageTrial.passed,
  debrisSmokePassed: debrisAndSmokeTrial.passed,
  policeCruiserPassed: policeCruiserCrashTrial.passed,
  exactRepairParity,
}));

if (!report.passed) {
  process.exit(1);
}
